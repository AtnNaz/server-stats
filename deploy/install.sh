#!/usr/bin/env bash
# Node Stats panelini systemd servisi olarak kurar; tekrar çalıştırılırsa günceller.
# Kullanım: sudo ./deploy/install.sh [--docker]
#   --docker  servis kullanıcısını docker grubuna ekler ve Docker kartını açar
set -euo pipefail

APP_DIR=/opt/serverhealth
CONF_DIR=/etc/serverhealth
CONF_FILE=$CONF_DIR/config.json
UNIT_FILE=/etc/systemd/system/serverhealth.service
SVC_USER=serverhealth
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

WITH_DOCKER=0
for arg in "$@"; do
  case "$arg" in
    --docker) WITH_DOCKER=1 ;;
    -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Bilinmeyen seçenek: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "Hata: $*" >&2; exit 1; }

# Dağıtımın paket yöneticisine uygun kurulum komutunu önerir.
pkg_hint() {
  if command -v apt-get >/dev/null; then echo "apt install $*"
  elif command -v dnf >/dev/null; then echo "dnf install $*"
  elif command -v yum >/dev/null; then echo "yum install $*"
  elif command -v zypper >/dev/null; then echo "zypper install $*"
  elif command -v pacman >/dev/null; then echo "pacman -S $*"
  elif command -v apk >/dev/null; then echo "apk add $*"
  else echo "paket yöneticinizle $* paketini kurun"
  fi
}

# İlk kurulumda izlenecek servisleri sistemin kendisinden seçer: her gruptan bu makinede
# bulunan ilk ad alınır (Debian "ssh", Fedora/RHEL "sshd" gibi).
detect_services() {
  local groups=(
    "ssh sshd" "cron crond cronie" "docker" "containerd" "nginx" "apache2 httpd" "caddy"
    "postgresql" "mariadb mysql" "redis-server redis" "ollama" "tailscaled" "fail2ban"
    "ufw firewalld" "smartmontools smartd"
  )
  local known found=()
  known=$(systemctl list-unit-files --type=service --no-legend 2>/dev/null | awk '{print $1}')
  for group in "${groups[@]}"; do
    for name in $group; do
      if grep -qx "$name.service" <<<"$known"; then found+=("$name"); break; fi
    done
  done
  printf '%s\n' "${found[@]}"
}

[[ $EUID -eq 0 ]] || die "root olarak çalıştırın: sudo $0"
command -v systemctl >/dev/null || die "systemd bulunamadı."

NODE_BIN="$(command -v node || true)"
[[ -n $NODE_BIN ]] || die "Node.js bulunamadı. Node 18.15 veya üstünü kurun: $(pkg_hint nodejs)"
NODE_BIN="$(readlink -f "$NODE_BIN")"
"$NODE_BIN" -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 18 || (a === 18 && b >= 15) ? 0 : 1)' \
  || die "Node.js $("$NODE_BIN" -v) çok eski; en az 18.15 gerekli."

# Yolun kendisi ve tüm üst klasörleri verilen sahiplere ait ve başkalarına yazılamaz mı?
# $2: izinli kullanıcı kimlikleri, $3: izinli grup kimlikleri (grup yazma izni için).
safe_path() {
  local p=$1 owner group mode
  while :; do
    read -r owner group mode < <(stat -c '%u %g %a' "$p") || return 1
    [[ " $2 " == *" $owner "* ]] || return 1
    (( (8#$mode & 8#002) == 0 )) || return 1
    (( (8#$mode & 8#020) == 0 )) || [[ " $3 " == *" $group "* ]] || return 1
    [[ $p == / ]] && return 0
    p=$(dirname "$p")
  done
}

# Root servisleri bu node'u çalıştırır; root dışında biri değiştirebiliyorsa root yetkisi alır.
safe_path "$NODE_BIN" "0" "0" \
  || die "node ($NODE_BIN) ya da bulunduğu klasörlerden biri root dışında birine ait veya yazılabilir (ör. nvm, n). Sistem paketinden kurulu bir Node kullanın: $(pkg_hint nodejs)"

# Kopyalanacak kod root olarak çalışacak: kaynak klasörü yalnızca root'a ya da kurulumu yapan
# yöneticiye ait olmalı (ör. /tmp altında başkasının açtığı bir klasör kabul edilmez).
ADMIN_UID=${SUDO_UID:-0}
ADMIN_GID=${SUDO_GID:-0}
SOURCES=("$SRC_DIR/src" "$SRC_DIR/public" "$SRC_DIR/bin" "$SRC_DIR/deploy" "$SRC_DIR/package.json" "$SRC_DIR/config.example.json" "$SRC_DIR/README.md" "$SRC_DIR/LICENSE")
safe_path "$SRC_DIR" "0 $ADMIN_UID" "0 $ADMIN_GID" \
  || die "$SRC_DIR ya da üst klasörlerinden biri başka bir kullanıcıya ait veya herkese yazılabilir. Projeyi kendi ev klasörünüze indirip oradan kurun (README: Kurulum)."
UNSAFE="$(find "${SOURCES[@]}" \( -type l -o -perm -0002 -o \( ! -uid 0 ! -uid "$ADMIN_UID" \) -o \( -perm -0020 ! -gid 0 ! -gid "$ADMIN_GID" \) \) -print -quit)"
[[ -z $UNSAFE ]] || die "Güvenli olmayan dosya: $UNSAFE (sembolik bağ, başka kullanıcıya ait ya da başkalarına yazılabilir)."

if ! id "$SVC_USER" &>/dev/null; then
  useradd --system --no-create-home --home-dir /nonexistent --shell "$(command -v nologin || echo /bin/false)" "$SVC_USER"
  echo "Sistem kullanıcısı oluşturuldu: $SVC_USER"
fi

if [[ "$SRC_DIR" != "$APP_DIR" ]]; then
  install -d -m 0755 "$APP_DIR"
  rm -rf "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/bin" "$APP_DIR/deploy"
  cp -R "$SRC_DIR/src" "$SRC_DIR/public" "$SRC_DIR/bin" "$SRC_DIR/deploy" "$APP_DIR/"
  install -m 0644 "$SRC_DIR/package.json" "$SRC_DIR/config.example.json" "$SRC_DIR/README.md" "$SRC_DIR/LICENSE" "$APP_DIR/"
  echo "Uygulama dosyaları kopyalandı: $APP_DIR"
fi
# Yerinde kurulumda da kod root'a ait olmalı; root servisleri bu dosyaları çalıştırır.
chown -R root:root "$APP_DIR"
chmod -R u=rwX,go=rX "$APP_DIR"

install -d -m 0750 -o root -g "$SVC_USER" "$CONF_DIR"
if [[ ! -f $CONF_FILE ]]; then
  install -m 0640 -o root -g "$SVC_USER" "$APP_DIR/config.example.json" "$CONF_FILE"
  read -rp "Panel kullanıcı adı [admin]: " PANEL_USER
  "$NODE_BIN" "$APP_DIR/bin/hash-password.js" --set "$CONF_FILE" --user "${PANEL_USER:-admin}"
  mapfile -t SERVICES < <(detect_services)
  "$NODE_BIN" -e '
    const fs = require("fs");
    const [file, ...services] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.services = services;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ' "$CONF_FILE" "${SERVICES[@]}"
  echo "Yapılandırma oluşturuldu: $CONF_FILE"
  echo "İzlenecek servisler (bu sistemde bulunanlar): ${SERVICES[*]:-yok}"
else
  echo "Mevcut yapılandırma korunuyor: $CONF_FILE"
fi

if (( WITH_DOCKER )); then
  getent group docker >/dev/null || die "docker grubu yok; Docker kurulu mu?"
  usermod -aG docker "$SVC_USER"
  "$NODE_BIN" -e '
    const fs = require("fs");
    const file = process.argv[1];
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    config.docker = { ...config.docker, enabled: true };
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
  ' "$CONF_FILE"
  echo "Docker kartı açıldı. Not: docker grubu fiilen root yetkisi verir."
fi

sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/serverhealth.service" > "$UNIT_FILE"
chmod 0644 "$UNIT_FILE"

# NVIDIA ekran kartı varsa servis, PrivateDevices yerine yalnızca bu aygıtlara izin veren
# bir aygıt listesiyle çalışır; böylece nvidia-smi karta erişebilir, diğer aygıtlar kapalı kalır.
GPU_DROPIN_DIR=/etc/systemd/system/serverhealth.service.d
GPU_DROPIN=$GPU_DROPIN_DIR/gpu.conf
if command -v nvidia-smi >/dev/null && ls /dev/nvidia[0-9]* >/dev/null 2>&1; then
  install -d -m 0755 "$GPU_DROPIN_DIR"
  {
    echo "# install.sh tarafından oluşturuldu: ekran kartı bilgisi için nvidia-smi erişimi"
    echo "[Service]"
    echo "PrivateDevices=no"
    echo "DevicePolicy=closed"
    for dev in /dev/nvidiactl /dev/nvidia[0-9]*; do echo "DeviceAllow=$dev rw"; done
  } > "$GPU_DROPIN"
  chmod 0644 "$GPU_DROPIN"
  echo "NVIDIA ekran kartı bulundu; servise yalnızca kart aygıtlarına erişim verildi."
else
  rm -f "$GPU_DROPIN"
fi

# Sistem ayarları yardımcısı: panel /var/lib/serverhealth-queue'ya istek bırakır,
# path birimi bunu görünce root yardımcısını çalıştırır; saatlik zamanlayıcı durumu tazeler.
for unit in serverhealth-helper.service serverhealth-helper.path serverhealth-helper.timer; do
  sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
# Kuyruk root'a aittir; panel içine dosya bırakabilir ama klasörün kendisini değiştiremez.
install -d -m 0730 -o root -g "$SVC_USER" /var/lib/serverhealth-queue

# Günlük rapor servisi; zamanlayıcısını panelden açılan ayara göre yardımcı kurar.
# Raporlar root:serverhealth 0640 yazılır (setgid klasör), panel yalnızca okur.
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/serverhealth-report.service" > /etc/systemd/system/serverhealth-report.service
chmod 0644 /etc/systemd/system/serverhealth-report.service
install -d -m 0755 /var/lib/serverhealth
install -d -m 2750 -o root -g "$SVC_USER" /var/lib/serverhealth/reports
install -d -m 0750 -o "$SVC_USER" -g "$SVC_USER" /var/lib/serverhealth-panel
rmdir /var/lib/serverhealth-panel/queue 2>/dev/null || true # eski sürümlerin kuyruğu

# Panel terminali: soket yalnızca panelin grubuna açıktır; panelden açılana kadar etkin değildir.
# Kabuğun hangi kullanıcıyla açılacağını root yardımcısı serverhealth-term@.service.d/user.conf ile yazar.
# Yapay zekâ komutları da aynı kullanıcıyla, ayrı bir soket üzerinden çalışır.
for unit in serverhealth-term.socket serverhealth-exec.socket; do
  install -m 0644 "$APP_DIR/deploy/$unit" "/etc/systemd/system/$unit"
done
if PYTHON_BIN="$(command -v python3)"; then
  for unit in serverhealth-term@.service serverhealth-exec@.service; do
    sed "s|/usr/bin/python3|$PYTHON_BIN|g" "$APP_DIR/deploy/$unit" > "/etc/systemd/system/$unit"
    chmod 0644 "/etc/systemd/system/$unit"
  done
else
  echo "Bilgi: python3 yok; panel terminali için gerekli: sudo $(pkg_hint python3)"
fi

# Docker yönetimi: panel Docker soketine erişmez; yalnızca listeleme ve başlat/durdur/yeniden başlat
# yapabilen, yetkisiz kısıtlanmış bir root yardımcısına soket üzerinden sorar.
install -m 0644 "$APP_DIR/deploy/serverhealth-docker.socket" /etc/systemd/system/serverhealth-docker.socket
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/serverhealth-docker@.service" > /etc/systemd/system/serverhealth-docker@.service
chmod 0644 /etc/systemd/system/serverhealth-docker@.service
DOCKER_HELPER=0
if command -v docker >/dev/null || [[ -S /run/docker.sock ]]; then DOCKER_HELPER=1; fi

# GitHub yedeği: kendi yetkisiz kullanıcısıyla çalışan servis. Zamanlayıcıyı ve yedek klasörünü
# panelin Ayarlar → GitHub yedekleme bölümünden root yardımcısı kurar.
if ! id serverhealth-backup >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /var/lib/serverhealth-backup --shell "$(command -v nologin || echo /bin/false)" serverhealth-backup
fi
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/serverhealth-github.service" > /etc/systemd/system/serverhealth-github.service
chmod 0644 /etc/systemd/system/serverhealth-github.service
command -v git >/dev/null || echo "Bilgi: git yok; GitHub yedeği için gerekli: sudo $(pkg_hint git)"

# Disk alanı analizi, günlük görüntüleyici ve güvenlik sayfası: root'a ait, yalnızca okuyan sorgu
# yardımcısı. Soket yalnızca panelin grubuna açıktır; her bağlantıda kısa ömürlü bir süreç başlar.
install -m 0644 "$APP_DIR/deploy/serverhealth-query.socket" /etc/systemd/system/serverhealth-query.socket
sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/serverhealth-query@.service" > /etc/systemd/system/serverhealth-query@.service
chmod 0644 /etc/systemd/system/serverhealth-query@.service

# SMART disk sağlığı: smartctl root ister, bu yüzden ayrı bir zamanlayıcı 10 dakikada bir
# /var/lib/serverhealth/smart.json dosyasını yazar; panel bu dosyayı yetkisiz okur.
SMART_SERVICE=/etc/systemd/system/serverhealth-smart.service
SMART_TIMER=/etc/systemd/system/serverhealth-smart.timer
if command -v smartctl >/dev/null; then
  sed "s|@NODE@|$NODE_BIN|g" "$APP_DIR/deploy/serverhealth-smart.service" > "$SMART_SERVICE"
  install -m 0644 "$APP_DIR/deploy/serverhealth-smart.timer" "$SMART_TIMER"
  chmod 0644 "$SMART_SERVICE"
  SMART_ENABLED=1
else
  if [[ -f $SMART_TIMER ]]; then
    systemctl disable --now serverhealth-smart.timer >/dev/null 2>&1 || true
    rm -f "$SMART_SERVICE" "$SMART_TIMER"
  fi
  SMART_ENABLED=0
  echo "Bilgi: smartctl yok. Disk sağlığı için smartmontools kurup bu betiği tekrar çalıştırın: sudo $(pkg_hint smartmontools)"
fi
systemctl daemon-reload
if (( SMART_ENABLED )); then
  systemctl enable --now serverhealth-smart.timer >/dev/null
  echo "SMART bilgisi toplanıyor (diskler okunurken biraz sürebilir)..."
  systemctl start serverhealth-smart.service || echo "Uyarı: SMART toplanamadı; ayrıntı: journalctl -u serverhealth-smart" >&2
fi
systemctl enable --now serverhealth-helper.path serverhealth-helper.timer >/dev/null
systemctl enable serverhealth-query.socket >/dev/null
if (( DOCKER_HELPER )); then
  systemctl enable serverhealth-docker.socket >/dev/null
  systemctl restart serverhealth-docker.socket
fi
systemctl restart serverhealth-query.socket
systemctl start serverhealth-helper.service || echo "Uyarı: sistem durumu okunamadı; ayrıntı: journalctl -u serverhealth-helper" >&2
systemctl enable serverhealth.service >/dev/null
systemctl restart serverhealth.service
sleep 2

if systemctl is-active --quiet serverhealth.service; then
  PORT="$("$NODE_BIN" -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).port ?? 8080)' "$CONF_FILE")"
  echo
  IP=$(ip -4 -o route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}')
  echo "Panel çalışıyor: http://${IP:-SUNUCU_IP}:$PORT/"
  echo "Ayarlar: $CONF_FILE  ·  Günlük: journalctl -u serverhealth -f"
else
  echo "Servis başlamadı. Ayrıntılar:" >&2
  journalctl -u serverhealth.service -n 20 --no-pager >&2 || true
  exit 1
fi
