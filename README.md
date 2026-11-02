# Sunucu Durumu

Linux sunucunuzun anlık durumunu tarayıcıda gösteren, şifre korumalı küçük bir web paneli.

Geliştirici: [Ali Toprak Naz](https://github.com/AtnNaz) · Lisans: [PolyForm Noncommercial 1.0.0](LICENSE) (kişisel kullanım serbest, ticari kullanım izne tabi; bkz. [Lisans](#lisans))

- **Sistem:** hostname, işletim sistemi, çekirdek, açık kalma süresi, CPU (toplam ve çekirdek başına), yük ortalaması, RAM/swap, disk doluluğu
- **Ağ:** arayüzler ve IP adresleri, anlık gelen/giden trafik, dinlenen TCP/UDP portlar
- **Süreçler:** CPU'ya veya belleğe göre en çok kaynak kullanan süreçler
- **Servisler:** seçtiğiniz systemd servislerinin durumu
- **Diskler:** her fiziksel diskin okuma/yazma hızı, meşguliyeti ve **SMART sağlık durumu** (bozuk sektörler, aşınma, sıcaklık, çalışma süresi); sorunlu diskler Genel bakış'ta uyarı olarak çıkar
- **Sıcaklık ve fanlar:** işlemci, NVMe diskler, anakart sensörleri ve fan devirleri
- **Ekran kartı:** NVIDIA kartlarda kullanım, VRAM, sıcaklık, güç ve kartı kullanan süreçler (`nvidia-smi` varsa kendiliğinden açılır)
- **Docker:** konteynerler ve durumları (isteğe bağlı)

Panel sol menüden bölümlere ayrılır (Genel bakış, Ekran kartı, Depolama, Ağ, Süreçler, Servisler); menüdeki rozetler sorunlu bölümleri işaret eder. Birkaç saniyede bir kendini günceller ve son 10 dakikanın grafiğini tutar. Giriş ekranından oturum açılır; aynı veriler `/api/stats` adresinden JSON olarak da alınabilir (bkz. [API](#api)).

Hiçbir npm paketine ihtiyaç duymaz; yalnızca Node.js'in kendi modüllerini kullanır ve bilgileri doğrudan `/proc`, `/sys` ve `systemctl` üzerinden okur. Tek dış bağlantı, iki günde bir GitHub'dan son sürüm numarasını sormaktır; bu istekte sunucuya dair hiçbir bilgi gönderilmez ve `"updateCheck": false` ile kapatılabilir.

## Gereksinimler

- systemd kullanan bir Linux dağıtımı (Ubuntu, Debian, RHEL, Rocky, Alma, Fedora…)
- Node.js **18.15 veya üstü**: `node -v` ile kontrol edin. Yoksa dağıtımınızın paket yöneticisinden ya da [NodeSource](https://github.com/nodesource/distributions) üzerinden kurun.

## Sisteme uyum

Panel kurulduğu makineyi kendisi tanır; sunucuya özgü bir ayar gerektirmez:

| Ne | Nasıl bulunur |
| --- | --- |
| Diskler, bağlama noktaları, okuma/yazma hızı | `/sys/block`, `/proc/diskstats`, `/proc/1/mountinfo` (LVM ve mdadm RAID'in altındaki fiziksel diskler dahil) |
| Disk sağlığı (SMART) | `smartctl --scan-open` ile bütün diskler; uykudaki diskler uyandırılmaz |
| Sıcaklık ve fanlar | `/sys/class/hwmon` içindeki tüm sensörler (Intel/AMD işlemci, NVMe, anakart yongaları, Dell/ThinkPad/ASUS vb.) |
| Ekran kartı | NVIDIA: `nvidia-smi` varsa; AMD ve Intel: `/sys/class/drm` |
| İzlenecek servisler | İlk kurulumda sistemde bulunan yaygın servisler (ssh/sshd, cron/crond, docker, nginx, postgresql…) |
| Kurulum ipuçları | Paket yöneticisine göre (apt, dnf, yum, zypper, pacman, apk) |

**Bilinen sınırlar**

- systemd gerekir (OpenRC/runit kullanan dağıtımlarda servis kurulumu çalışmaz).
- ZFS havuzları ve çok diskli btrfs, bağlama noktalarını sanal bir aygıt üzerinden bildirdiği için bu dosya sistemlerinin hangi fiziksel diskte durduğu eşlenemez; diskler yine listelenir ama "Bağlı değil" görünebilir.
- Donanım RAID kartlarının (MegaRAID vb.) arkasındaki disklerin SMART bilgisi toplanır ama panelde gösterilmez.
- Süreç başına ekran kartı belleği yalnızca NVIDIA kartlarda okunabilir.

## Kurulum

1. Projeyi sunucuda kendi ev klasörünüze indirin:

   ```bash
   git clone https://github.com/AtnNaz/server-stats.git ~/server-stats
   ```

   Sunucuda git yoksa klasörü kendi bilgisayarınızdan kopyalayabilirsiniz: `rsync -a --exclude config.json --exclude state ./ kullanici@sunucu:server-stats/`. Herkesin yazabildiği `/tmp` gibi bir klasör kullanmayın; kurulum betiği root olarak çalışır.

2. Sunucuda kurulum betiğini çalıştırın:

   ```bash
   sudo ~/server-stats/deploy/install.sh
   ```

   Betik şunları yapar:
   - `serverhealth` adında yetkisiz bir sistem kullanıcısı oluşturur
   - uygulamayı `/opt/serverhealth` altına kopyalar
   - `/etc/serverhealth/config.json` dosyasını oluşturur, panel için kullanıcı adı ve şifre sorar
   - systemd servisini kurar, açılışta başlayacak şekilde etkinleştirir ve başlatır

   Docker konteynerlerini de görmek istiyorsanız `--docker` ekleyin (aşağıdaki güvenlik notunu okuyun).

3. Tarayıcıda `http://SUNUCU_IP:8080/` adresini açın ve kurulumda belirlediğiniz kullanıcı adı ve şifreyle oturum açın. Güvenlik duvarı kullanıyorsanız portu açın, ör. `sudo ufw allow 8080/tcp`.

> **Önemli:** Düz HTTP üzerinde giriş şifresi ve oturum çerezi ağda okunabilir. Giriş ekranı bu durumu "Bağlantı şifrelenmemiş" diye gösterir. Panel internete açıksa aşağıdaki [HTTPS](#https) seçeneklerinden birini mutlaka kullanın.

### Oturumlar

- "Beni hatırla" seçilirse oturum 30 gün, seçilmezse tarayıcı kapanana kadar (en çok 12 saat) sürer.
- Oturumlar bellekte tutulur. Servis yeniden başlatıldığında ya da güncellendiğinde herkesin yeniden giriş yapması gerekir.
- Çıkış için sağ üstteki kullanıcı menüsünden **Çıkış yap**'ı seçin.

### Güncelleme

`cd ~/server-stats && git pull` ile yeni sürümü indirip `sudo ./deploy/install.sh` komutunu tekrar çalıştırın. Mevcut yapılandırma korunur, servis yeniden başlatılır.

### Kaldırma

```bash
sudo systemctl disable --now serverhealth serverhealth-smart.timer serverhealth-helper.path serverhealth-helper.timer serverhealth-reboot.timer serverhealth-smarttest-short.timer serverhealth-smarttest-long.timer
sudo rm -rf /opt/serverhealth /etc/systemd/system/serverhealth* /etc/serverhealth /var/lib/serverhealth /var/lib/serverhealth-panel /var/lib/serverhealth-queue /etc/apt/apt.conf.d/52serverhealth
sudo systemctl daemon-reload
sudo userdel serverhealth
```

## Yapılandırma

Ayarlar `/etc/serverhealth/config.json` dosyasındadır. Değişiklikten sonra `sudo systemctl restart serverhealth` çalıştırın.

| Alan | Varsayılan | Açıklama |
| --- | --- | --- |
| `host` | `"0.0.0.0"` | Dinlenecek adres. Yalnızca nginx veya SSH tüneli ile erişilecekse `"127.0.0.1"` |
| `port` | `8080` | Dinlenecek port |
| `intervalSeconds` | `3` | Verilerin kaç saniyede bir toplanacağı (1–60) |
| `historyMinutes` | `10` | Grafiklerde gösterilecek süre (dakika) |
| `trustProxy` | `false` | Ters vekil (nginx) arkasındaysa `true`; kilitleme için istemci IP'si `X-Real-IP` başlığından alınır |
| `ollama.url` | `"http://127.0.0.1:11434"` | Günlük rapor için Ollama adresi; yalnızca bu makine olabilir |
| `reports.dir` | `"/var/lib/serverhealth/reports"` | Günlük raporların yazıldığı klasör |
| `updateCheck` | `true` | İki günde bir GitHub'daki son sürüme bakar; yeni sürüm varsa Ayarlar → Hakkında'da gösterir |
| `allowedHosts` | `[]` | Panelin kabul ettiği ek adlar (ör. `["durum.ornek.com"]`). Sunucunun kendi IP adresleri, makine adı ve `localhost` her zaman kabul edilir; başka adlarla gelen istekler (DNS rebinding) reddedilir. `["*"]` denetimi kapatır |
| `auth.username` | `"admin"` | Panel kullanıcı adı |
| `auth.passwordHash` | — | Şifrenin scrypt hash'i (düz şifre yazmayın, aşağıya bakın) |
| `tls.cert`, `tls.key` | `""` | Doğrudan HTTPS için sertifika ve anahtar dosyaları |
| `services` | kurulumda otomatik | İzlenecek systemd birimleri, ör. `["nginx", "postgresql", "docker"]`. İlk kurulumda betik, sistemde bulunan yaygın servisleri (ssh/sshd, cron/crond, docker, nginx, postgresql…) kendisi seçer |
| `docker.enabled` | `false` | Docker kartını açar |
| `docker.socket` | `"/var/run/docker.sock"` | Docker soketi |
| `gpu.enabled` | `true` | `nvidia-smi` bulunursa ekran kartı kartını gösterir; `false` kapatır |
| `processes.top` | `10` | Listelenecek süreç sayısı |
| `processes.showCommandLine` | `true` | `false` olursa yalnızca süreç adı gösterilir (komut satırındaki parolalar görünmez) |
| `smart.file` | `"/var/lib/serverhealth/smart.json"` | SMART zamanlayıcısının yazdığı dosya |
| `disks.hide` | `["/boot", "/boot/efi", "/efi"]` | Diskler kartında gösterilmeyecek bağlama noktaları; `*` joker karakterdir (ör. `"/mnt/yedek*"`) |
| `network.hideInterfaces` | `["lo", "veth*", "br-*", "docker*", "virbr*"]` | Gizlenecek arayüzler; `*` joker karakterdir |

### Şifreyi değiştirmek

```bash
sudo node /opt/serverhealth/bin/hash-password.js --set /etc/serverhealth/config.json
```

```bash
sudo systemctl restart serverhealth
```

Kullanıcı adını da değiştirmek için `--user yeniad` ekleyin. `--set` olmadan çalıştırırsanız hash yalnızca ekrana yazılır.

Şifre panelden (Ayarlar → Güvenlik) de değiştirilebilir. Şifreyi unutursanız yukarıdaki komut yine işe yarar: `config.json` sonradan değiştirilince panelde ayarlanmış şifre geçersiz olur ve `config.json`'daki şifre kullanılır.

## API

Panelin kullandığı veriler JSON olarak alınabilir. Betiklerden kullanıcı adı ve şifreyle (HTTP Basic Auth) erişin:

```bash
curl -u admin:SIFRE http://SUNUCU_IP:8080/api/stats
```

Oturum yoksa `/api/stats` 401 döndürür; sayfa istekleri ise giriş ekranına yönlendirilir. `/healthz` şifresizdir ve yalnızca `ok` döndürür.

## Günlük rapor (Ollama)

Sunucuda [Ollama](https://ollama.com) kuruluysa panel her gün son 24 saatin sistem kayıtlarını özetleyip yerel bir modele yorumlatabilir. Ayarlar → Günlük rapor'dan açılır; saat ve model (Ollama'da yüklü modeller listelenir) oradan seçilir. Raporlar sol menüdeki **Raporlar** sayfasında 30 gün saklanır; "Şimdi oluştur" ile istendiğinde de hazırlanır.

- Rakamlar (başarısız SSH ve sudo girişleri, çöken servisler, bellek yetmediği için kapatılan süreçler, disk hataları, en sık uyarılar) kodla hesaplanır; model yalnızca bu özeti yorumlar ve öneri yazar. 3-4B boyutunda bir model yeterlidir.
- Kayıtlar sunucudan dışarı çıkmaz: rapor servisi ağda yalnızca bu makineye bağlanabilir (`IPAddressDeny=any`) ve Ollama adresi yalnızca `127.0.0.1`/`localhost` olabilir. Parola ve token benzeri değerler maskelenir.
- Kayıt metinleri modele talimat olarak değil veri olarak verilir; modelin hiçbir yetkisi yoktur ve çıktısı panelde düz metin olarak gösterilir. Küçük modeller yanılabilir; önemli kararlardan önce rakamlara bakın.
- Ollama yoksa ya da yanıt vermezse rapor yine hazırlanır, yalnızca rakamlardan oluşur.

## HTTPS

### nginx arkasında (önerilen)

`config.json` içinde `"host": "127.0.0.1"`, `"trustProxy": true` ve `"allowedHosts": ["durum.ornek.com"]` yapın, sonra nginx'e şu sunucu bloğunu ekleyin:

```nginx
server {
    listen 443 ssl;
    server_name durum.ornek.com;

    ssl_certificate     /etc/letsencrypt/live/durum.ornek.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/durum.ornek.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### SSH tüneli ile

Panel hiç dışarı açılmaz. `"host": "127.0.0.1"` yapın ve kendi bilgisayarınızdan bağlanın:

```bash
ssh -L 8080:127.0.0.1:8080 kullanici@sunucu
```

Ardından `http://localhost:8080/` adresini açın.

### Doğrudan HTTPS

Let's Encrypt anahtarlarını yalnızca root okuyabildiği için systemd bunları servise `LoadCredential` ile güvenli şekilde verir:

1. `sudo systemctl edit serverhealth` ile şunu ekleyin (alan adını kendinizinkiyle değiştirin):

   ```ini
   [Service]
   LoadCredential=tls.cert:/etc/letsencrypt/live/durum.ornek.com/fullchain.pem
   LoadCredential=tls.key:/etc/letsencrypt/live/durum.ornek.com/privkey.pem
   ```

2. `config.json` içinde:

   ```json
   "tls": {
     "cert": "${CREDENTIALS_DIRECTORY}/tls.cert",
     "key": "${CREDENTIALS_DIRECTORY}/tls.key"
   }
   ```

3. Sertifika yenilendiğinde servisin yeni sertifikayı alması için certbot'a yeniden başlatma kancası ekleyin:

   ```bash
   echo 'systemctl restart serverhealth' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/serverhealth.sh && sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/serverhealth.sh
   ```

## Güvenlik notları

- Şifre yapılandırmada scrypt ile hash'lenmiş olarak durur; karşılaştırma sabit zamanlıdır.
- Aynı IP'den 15 dakika içinde 5 hatalı denemeden sonra o IP 15 dakika kilitlenir; giriş ekranı kalan süreyi gösterir. Tüm adreslerden toplam 30 hatalı deneme olursa giriş 15 dakika tamamen kapanır (adres değiştirerek şifre denemeye karşı). Denemeler `journalctl -u serverhealth` günlüğüne yazılır.
- Oturum çerezi `HttpOnly` ve `SameSite=Strict`'tir; HTTPS üzerinde `Secure` olarak işaretlenir ve HSTS başlığı gönderilir. Giriş ve çıkış istekleri yalnızca panelin kendi sayfasından ve tanınan adlardan (`allowedHosts`) kabul edilir.
- Root yardımcısına giden istek kuyruğu `/var/lib/serverhealth-queue` root'a aittir: panel içine dosya bırakabilir ama klasörü değiştiremez. Yardımcı dosyaları sembolik bağ izlemeden açar ve her isteği yeniden doğrular.
- Kurulum betiği, root servislerinin çalıştıracağı `node` ikilisinin ve kaynak klasörünün başka kullanıcılarca değiştirilemediğini denetler; değilse kurulumu durdurur.
- Servis yetkisiz `serverhealth` kullanıcısıyla, dosya sistemine yazma izni olmadan çalışır (systemd sıkılaştırması: `ProtectSystem=strict`, `NoNewPrivileges` vb.).
- **SMART:** Disk sağlığını okumak root yetkisi ister. Panel bunu kendisi yapmaz. `smartmontools` kuruluysa kurulum betiği `serverhealth-smart.timer` zamanlayıcısını kurar: her 10 dakikada bir root olarak `smartctl` çalıştırır, sonucu `/var/lib/serverhealth/smart.json` dosyasına yazar, panel bu dosyayı yetkisiz okur. Toplayıcının ağ erişimi yoktur, dosya sistemine yalnızca bu klasöre yazabilir ve uykudaki diskleri uyandırmaz.
- NVIDIA kartı olan sunucularda kurulum betiği `/etc/systemd/system/serverhealth.service.d/gpu.conf` dosyasını yazar: servis `/dev` altında yalnızca `/dev/nvidiactl` ve `/dev/nvidiaN` aygıtlarına (ve `/dev/null` gibi temel aygıtlara) erişebilir.
- `/healthz` adresi şifresizdir ve yalnızca `ok` döndürür; izleme araçları için.
- **Docker:** Docker soketine erişebilen herkes fiilen root yetkisine sahiptir. `--docker` seçeneği servis kullanıcısını `docker` grubuna ekler. Panel yalnızca konteyner listesini okur, ama uygulamada bir açık bulunursa bu yetki kötüye kullanılabilir. Gerçekten ihtiyacınız varsa açın.
- Süreç komut satırları bazen parola içerebilir (ör. `mysql -pGizli`). Bunu istemiyorsanız `processes.showCommandLine` değerini `false` yapın.
- Bir portu hangi sürecin dinlediği gösterilmez; bunun için root yetkisi gerekir.

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Servis başlamıyor | `journalctl -u serverhealth -n 50`: yapılandırma hataları burada satır satır yazılır |
| `Port 8080 başka bir uygulama tarafından kullanılıyor` | `config.json` içinde başka bir `port` seçin |
| Servisler kartında `systemctl hatası` | Birim adlarını `systemctl status AD` ile kontrol edin |
| Docker kartında `erişim izni yok` | `sudo ./deploy/install.sh --docker` çalıştırın |
| Bir disk `yanıt vermiyor` | Ağ diski (NFS/CIFS) erişilemiyor; panel diğer verileri göstermeye devam eder |

## Geliştirme

```bash
npm test                          # ayrıştırıcı ve kimlik doğrulama testleri
node src/server.js --config config.json
```

`config.json` dosyası `.gitignore` içindedir.

## Lisans

Bu proje [PolyForm Noncommercial License 1.0.0](LICENSE) ile lisanslanmıştır.

- **Serbest:** kişisel kullanım, hobi projeleri, öğrenme ve araştırma; okul, dernek, vakıf ve kamu kurumu gibi ticari olmayan kuruluşlarda kullanım. Değiştirip paylaşabilirsiniz; lisans metni ve telif satırı korunmalıdır.
- **İzin gerekir:** şirket içinde, ücretli bir hizmette ya da satılan bir ürünün parçası olarak kullanım gibi her türlü ticari kullanım. Ticari lisans için [GitHub üzerinden](https://github.com/AtnNaz) Ali Toprak Naz ile iletişime geçin.

Free for personal and noncommercial use under the PolyForm Noncommercial License 1.0.0. Commercial use requires prior written permission from the author, Ali Toprak Naz.
