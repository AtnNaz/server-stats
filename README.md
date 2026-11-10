# Node Stats

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
- **Konteynerler:** bütün Docker konteynerleri Compose projelerine göre gruplanmış hâlde; her birinin durumu, sağlığı, CPU, bellek ve ağ kullanımı, açık kalma süresi, yeniden başlama sayısı ve portları. Başlat / durdur / yeniden başlat düğmeleri, kayıtlarına tek tıkla geçiş ve imajın yeni sürümü çıktığında işaret (bkz. [Konteynerler](#konteynerler))
- **Disk sağlığı geçmişi:** Depolama sayfasında her diskin sıcaklığı, bozuk sektör sayaçları (taşınan, okunamayan, düzeltilemeyen), SSD aşınması ve yazılan veri 7 gün / 30 gün / 1 yıllık grafiklerle gösterilir. Değerler SMART'tan saatte bir kaydedilir ve 13 ay saklanır. Bir diskin bozuk sektör sayacı son 7 günde artarsa Genel bakış'ta uyarı çıkar; SSD aşınması artıyorsa bu hızla kalan ömür kabaca tahmin edilir
- **Disk alanı analizi:** Depolama sayfasında bir diski taratıp hangi klasörün ne kadar yer kapladığını kutu haritasında görürsünüz; klasörlere tıklayarak inilir, en büyük dosyalar listelenir (bkz. [Disk alanı, günlükler ve güvenlik](#disk-alanı-günlükler-ve-güvenlik))
- **Günlükler:** sistem günlüğü, tek bir servis, çekirdek ya da Docker konteyneri kayıtları; önem derecesi, zaman aralığı ve metinle süzülür, canlı izlenebilir
- **GitHub yedeği:** Ayarlar'a GitHub kullanıcı adınızı girersiniz; repolarınız her gün bu sunucuya kopyalanır: bütün commit'ler, branch'ler, tag'ler, release'ler (notları ve dosyalarıyla), isteğe bağlı issue/PR'lar ve wiki. GitHub'da silinen hiçbir şey yedekten silinmez (bkz. [GitHub yedeği](#github-yedeği))
- **Servis izleme:** İzleme sayfasında eklediğin web adreslerine (HTTP/HTTPS) ya da sunucu:port hedeflerine (TCP) 30 saniye–5 dakikada bir bağlanılır; yanıt süresi, son 24 saatin durum şeridi, 24 saat / 7 gün / 30 gün çalışma yüzdesi ve kesinti listesi gösterilir. Bir hedef üst üste iki denetimde yanıt vermezse Genel bakış'ta uyarı çıkar (bkz. [Servis izleme](#servis-izleme))
- **Güvenlik:** dinlenen portlar ve hangi programa/konteynere ait oldukları, kime açık oldukları (bu makine, Tailscale, bütün ağlar), SSH ayarları, başarısız ve başarılı girişler, oturum açabilen kullanıcılar ve bunlardan çıkan öneriler
- **İnternet hızı:** Ağ sayfasından tek tıkla hız testi (sunucu ile Cloudflare arasında indirme, yükleme, gecikme); isteğe bağlı 1–24 saatte bir otomatik test ve geçmiş grafiği
- **Güncelleme önizlemesi:** Ayarlar → Güncellemeler'de bekleyen paketlerin listesi (güvenlik güncellemeleri işaretli) ve yerel modelle kısa bir özet
- **Geçmiş:** işlemci, bellek, sıcaklık, ağ, disk ve ekran kartı değerleri dakikalık olarak 30 gün saklanır; son 24 saat, 7 gün ve 30 günlük grafikler
- **Terminal:** sunucunun komut satırı tarayıcıda (htop, nano, sudo çalışır); seçtiğiniz kullanıcıyla açılır, varsayılan kapalıdır (bkz. [Terminal](#terminal))
- **Yapay zekâ:** sunucudaki [Ollama](https://ollama.com) ile sohbet, model indirme/silme ve hız testi; hiçbir şey dışarı gönderilmez. Sohbetler sunucuda saklanır (`/var/lib/serverhealth-panel/chats`), böylece başka bir cihazdan da devam edilir; ekran kartı belleğine sığan modeller önerilir. Model sunucunun anlık durumunu (diskler, SMART, sıcaklık, ekran kartı, servisler, güncellemeler, son rapor) her zaman görür. "Komut çalıştırma" açıksa sorunları araştırmak için kendisi komut da çalıştırabilir (bkz. [Yapay zekâ komutları](#yapay-zekâ-komutları))

Panel sol menüden bölümlere ayrılır (Genel bakış, Geçmiş, Ekran kartı, Depolama, Ağ, İzleme, Süreçler, Servisler, Konteynerler, Günlükler, Güvenlik, Yedekler, Terminal, Yapay zekâ, Raporlar); menüdeki rozetler sorunlu bölümleri işaret eder. Birkaç saniyede bir kendini günceller; canlı grafikler son 10 dakikayı, Geçmiş sayfası son 30 günü gösterir. Giriş ekranından oturum açılır; aynı veriler `/api/stats` adresinden JSON olarak da alınabilir (bkz. [API](#api)).

Hiçbir npm paketine ihtiyaç duymaz; yalnızca Node.js'in kendi modüllerini kullanır (terminal ekranı için [xterm.js](https://xtermjs.org) dosyaları `public/vendor` içinde gelir, MIT lisanslı) ve bilgileri doğrudan `/proc`, `/sys` ve `systemctl` üzerinden okur. Kendiliğinden yapılan tek dış bağlantı, iki günde bir GitHub'dan son sürüm numarasını sormaktır; bu istekte sunucuya dair hiçbir bilgi gönderilmez ve `"updateCheck": false` ile kapatılabilir. İnternet hız testi yalnızca siz başlattığınızda ya da Ağ sayfasında otomatik testi açtığınızda Cloudflare'in hız testi sunucusuna (`speed.cloudflare.com`) bağlanır.

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

- "Beni hatırla" seçilirse oturum 30 gün sürer ve panel kullanıldıkça yeniden 30 güne uzar; seçilmezse tarayıcı kapanana kadar (en çok 12 saat) sürer. Oturumlar panelin durum klasöründe (`sessions.json`, yalnızca panel kullanıcısı okuyabilir) saklandığı için panel güncellenince ya da sunucu yeniden başlayınca kapanmaz. Dosyada çerezdeki belirtecin kendisi değil yalnızca özeti durur. Şifre değişince (arayüzden ya da `config.json`'dan) bütün eski oturumlar geçersiz olur.
- Çıkış için sağ üstteki kullanıcı menüsünden **Çıkış yap**'ı seçin.

### Güncelleme

Panel iki günde bir yeni sürüm olup olmadığına bakar. Yeni sürüm varsa Ayarlar → Hakkında'daki **Güncellemeyi kur** düğmesiyle kurulabilir: root yardımcısı kurulu depodaki son sürümü GitHub'dan indirir ve kurar; panel birkaç saniyeliğine yeniden başlar.

Elle güncellemek için `cd ~/server-stats && git pull` ile yeni sürümü indirip `sudo ./deploy/install.sh` komutunu tekrar çalıştırın. İki yolda da mevcut yapılandırma korunur.

### Kaldırma

```bash
sudo systemctl disable --now serverhealth serverhealth-query.socket serverhealth-docker.socket serverhealth-github.timer serverhealth-smart.timer serverhealth-helper.path serverhealth-helper.timer serverhealth-reboot.timer serverhealth-smarttest-short.timer serverhealth-smarttest-long.timer
sudo rm -rf /opt/serverhealth /etc/systemd/system/serverhealth* /etc/serverhealth /var/lib/serverhealth /var/lib/serverhealth-panel /var/lib/serverhealth-queue /etc/apt/apt.conf.d/52serverhealth
sudo systemctl daemon-reload
sudo userdel serverhealth
sudo userdel serverhealth-backup
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
| `history.retentionDays` | `30` | Geçmiş sayfası için dakikalık ölçümlerin kaç gün saklanacağı (1–365); dosyalar `/var/lib/serverhealth-panel/history` altındadır, günde yaklaşık 0,5 MB |
| `terminal.idleMinutes` | `15` | Terminal bu kadar dakika tuşa basılmazsa kapanır |
| `terminal.socket` | `"/run/serverhealth-term.sock"` | Terminal soketi (kurulum betiğiyle aynı kalmalı) |
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

Sunucuda [Ollama](https://ollama.com) kuruluysa panel her gün son 24 saatin sistem kayıtlarını özetleyip yerel bir modele yorumlatabilir. Ayarlar → Günlük rapor'dan açılır; saat ve model (Ollama'da yüklü modeller listelenir) oradan seçilir. Raporlar sol menüdeki **Raporlar** sayfasında 30 gün saklanır; "Şimdi oluştur" ile istendiğinde de hazırlanır. **PDF indir** düğmesi raporu yazdırma penceresinde A4'e uygun, açık renkli bir düzende açar; hedef olarak "PDF olarak kaydet" seçilir (Türkçe karakterler korunur, ek bir program gerekmez).

- Rakamlar (başarısız SSH ve sudo girişleri, çöken servisler, bellek yetmediği için kapatılan süreçler, disk hataları, en sık uyarılar) kodla hesaplanır; model yalnızca bu özeti yorumlar ve öneri yazar. 3-4B boyutunda bir model yeterlidir.
- Modele her diskin rolü (sistem diski, veri diski, kullanılmayan disk), SMART sayaçları (taşınan, okunamayan ve düzeltilemeyen sektörler, NVMe ortam hataları) ve bu sayaçların günler içindeki değişimi de verilir; böylece sabit kalan bir veri diski uyarısı acil durum gibi gösterilmez. Sayaç geçmişi `/var/lib/serverhealth/reports/smart-history.json` dosyasında tutulur.
- Sunucu açılırken (ilk 3 dakika) ya da kapanırken (son 2 dakika) görülen olaylar ayrıca işaretlenir; bu sürelerdeki ağ zaman aşımları ve durdurulan servisler normal sayılır.
- Kayıtlardaki adreslerde sunucu adı ve yol korunur, sorgu dizesi ve token'a benzeyen parçalar gizlenir.
- Kayıtlar sunucudan dışarı çıkmaz: rapor servisi ağda yalnızca bu makineye bağlanabilir (`IPAddressDeny=any`) ve Ollama adresi yalnızca `127.0.0.1`/`localhost` olabilir. Parola ve token benzeri değerler maskelenir.
- Kayıt metinleri modele talimat olarak değil veri olarak verilir; modelin hiçbir yetkisi yoktur ve çıktısı panelde düz metin olarak gösterilir. Küçük modeller yanılabilir; önemli kararlardan önce rakamlara bakın.
- Ollama yoksa ya da yanıt vermezse rapor yine hazırlanır, yalnızca rakamlardan oluşur.

## Terminal

Sol menüdeki **Terminal** sayfasından açılır: bir kullanıcı seçip "Terminali aç" dersiniz, root yardımcısı terminal soketini etkinleştirir. Kabuk o kullanıcıyla, normal bir SSH oturumu gibi çalışır; `sudo` her seferinde o kullanıcının şifresini terminalde sorar. Aynı sayfadan kapatılır.

- Panel servisi kabuğu kendisi açmaz. systemd, `/run/serverhealth-term.sock` soketine gelen her bağlantı için seçilen kullanıcıyla ayrı bir `serverhealth-term@` servisi başlatır; sokete yalnızca panel servisinin grubu bağlanabilir. root seçilemez ve köprü root olarak kabuk açmayı reddeder.
- Bağlantı yalnızca tarayıcı oturumuyla ve panelin kendi sayfasından kurulur (Basic Auth ve başka sitelerden gelen istekler reddedilir). Oturum kapanınca ya da `terminal.idleMinutes` boyunca tuşa basılmazsa terminal kapanır. Açılış ve kapanışlar `journalctl -u serverhealth` günlüğüne yazılır; yazılan komutlar kaydedilmez.
- Terminalde yazdıklarınız (sudo şifresi dahil) ağda panelle aynı yoldan gider. Düz HTTP üzerinde kullanmayın; HTTPS, SSH tüneli ya da Tailscale gibi şifreli bir bağlantı kullanın. Panel şifrelenmemiş bağlantıda uyarı gösterir.
- Terminal ekranı xterm.js çalışırken stil etiketi eklediği için yalnızca `/terminal` sayfasının güvenlik politikası satır içi stillere izin verir; betikler yine yalnızca panelin kendi dosyalarından yüklenir.
- Gereksinim: `python3` (Ubuntu ve Debian'da hazır gelir).

## Disk alanı, günlükler ve güvenlik

Bu üç sayfa root yetkisi ister (her klasörü görebilmek, sistem günlüğünü okumak, bir portun hangi programa ait olduğunu bulmak). Panel bunu kendisi yapmaz: kurulum betiği `serverhealth-query.socket` soketini kurar ve systemd, sokete gelen her istek için kısa ömürlü bir `serverhealth-query@` servisi başlatır.

- Sokete yalnızca panel servisinin grubu bağlanabilir. Yardımcı her isteği yeniden doğrular; yapabildikleri sabittir ve hepsi yalnızca okumadır: klasör boyutlarını ölçmek, `journalctl` ile kayıt okumak, Docker konteyner kayıt dosyalarını okumak, `/proc` altından soketlerin sahibi olan süreçleri bulmak, `sshd_config`, `/etc/passwd`, `/etc/group` ve şifre dosyasındaki durum alanını (şifre var/boş/kilitli; hash'in kendisi hiçbir yere gönderilmez) okumak.
- Servis root çalışır ama yalnızca iki yetkisi vardır: her dosyayı okuyabilmek (`CAP_DAC_READ_SEARCH`) ve başka kullanıcıların süreçlerinin açık soketlerini görebilmek (`CAP_SYS_PTRACE`). Dosya sistemi salt okunurdur, ağ bağlantısı açamaz (`IPAddressDeny=any`), en fazla 200 saniye çalışır.
- **Disk alanı:** dosyaların içeriği okunmaz, yalnızca adları ve diskte kapladıkları yer. Tarama başka disklere geçmez (bağlı diskler ayrıca listelenir), sabit bağlantıları bir kez sayar ve en fazla 150 saniye sürer. Son 8 tarama 30 dakika panelin belleğinde tutulur.
- **Günlükler:** Docker konteyner kayıtları `json-file` sürücüsüyle yazılan dosyalardan okunur; panel servisinin `docker` grubunda olması gerekmez. Konteyner kayıtlarında önem derecesi olmadığı için satırdaki `ERROR`, `WARN` gibi sözcüklerden tahmin edilir.
- **Güvenlik:** öneriler panelde hesaplanır; panel hiçbir ayarı değiştirmez. "Bütün ağlar" yerel ağdaki herkesin, modemde port yönlendirmesi varsa internetin bağlanabileceği anlamına gelir.

## Konteynerler

**Konteynerler** sayfası Docker konteynerlerini listeler ve başlatıp durdurmayı sağlar. Panel Docker soketine kendisi erişmez (bu fiilen root yetkisi demektir); kurulum betiği `serverhealth-docker.socket` soketini kurar ve her istekte kısa ömürlü bir `serverhealth-docker@` servisi çalışır.

- Yardımcının yapabildikleri sabittir: konteynerleri, kaynak kullanımlarını ve imaj özetlerini okumak; var olan bir konteyneri kimliğiyle başlatmak, durdurmak ya da yeniden başlatmak. Konteyner oluşturamaz, silemez, içinde komut çalıştıramaz, imaj çekemez.
- Servis root olarak yalnızca Docker soketine bağlanmak için çalışır; hiçbir yetkisi (capability) yoktur, dosya sistemine yazamaz, ağa çıkamaz. Her işlem `journalctl -u 'serverhealth-docker@*'` ve `journalctl -u serverhealth` günlüklerine yazılır.
- **Yeni sürüm denetimi:** panel her imajın etiketini kayıt sunucusunda (Docker Hub, GitHub, lscr.io ve diğer OCI kayıtları) anonim olarak sorar ve yereldeki özetle karşılaştırır; 6 saatte bir ya da **Güncellemeleri denetle** ile. Sunucuya dair bilgi gönderilmez. Özetle (`@sha256:…`) sabitlenmiş ve yerelde derlenmiş imajlar ayrıca işaretlenir. Güncellemenin kendisi CasaOS ya da `docker compose pull && docker compose up -d` ile yapılır; panel konteyner oluşturmaz.

## Servis izleme

**İzleme** sayfasındaki **Hedef ekle** ile bir ad, tür ve adres girilir:

- **HTTP / HTTPS:** adres yanıt verirse ayakta sayılır. 5xx yanıtları ve bağlantı hataları kesintidir; giriş isteyen paneller (401, 302) ayakta sayılır.
- **TCP portu:** `sunucu:port` biçiminde (ör. `127.0.0.1:5432`); porta bağlanılabiliyorsa ayaktadır.

Denetimler panelin kendisinden, yani sunucudan yapılır; aynı makinedeki servisler için `127.0.0.1` kullanılabilir. Tek bir başarısız denetim kesinti sayılmaz, üst üste iki tanesi sayılır; kesinti ilk başarısız denetimden başlatılır ve ilk başarılı denetimde kapanır. Sonuçlar panelin durum klasöründe (`/var/lib/serverhealth-panel/uptime`) 31 gün saklanır. En fazla 30 hedef eklenebilir.

## GitHub yedeği

**Ayarlar → GitHub yedekleme** bölümüne GitHub kullanıcı adınızı ve yedeklerin duracağı klasörü (ör. ayrı bir diskte `/mnt/disk/github-yedek`) girip açın. Yedek her gün seçtiğiniz saatte alınır; sunucu o saatte kapalıysa açılışta alınır. **Yedekler** sayfası son yedeği, repoları ve geçmiş çalışmaları gösterir; oradan "Şimdi yedekle" de denebilir. Yedek başarısız olursa ya da 2 günden uzun süre alınamazsa Genel bakış'ta uyarı çıkar.

Yedek klasöründe her repo için:

| Yol | İçerik |
| --- | --- |
| `<kullanıcı>/<repo>/kod.git` | Bütün branch, tag ve pull request referanslarıyla çıplak git aynası |
| `<kullanıcı>/<repo>/wiki.git` | Wiki (varsa) |
| `<kullanıcı>/<repo>/release/<tag>/` | `release.json` (notlar), ekli dosyalar (`dosyalar/`), `kaynak.tar.gz` |
| `<kullanıcı>/<repo>/issue/<no>.json` | Issue ve PR'lar, yorumları ve inceleme yorumlarıyla |
| `<kullanıcı>/<repo>/repo.json` | Açıklama, görünürlük, yedek bilgisi |

- **Yalnızca değişenler alınır.** İlk yedekten sonra repolar baştan indirilmez: son yedekten beri push yapılmamış repo hiç çekilmez, push yapılmışsa yalnızca yeni commit'ler gelir. Release dosyaları değişmedikçe yeniden indirilmez, issue/PR'lardan yalnızca son yedekten beri güncellenenler alınır.
- **Hiçbir şey silinmez.** GitHub'da silinen repo, branch, tag ve release yedekte kalır ve "GitHub'da yok" diye işaretlenir. Bir branch force-push ile yeniden yazılırsa önceki hâli `refs/yedek/zorla/<zaman>/` altında saklanır. Git'in referans günlüğü hiç temizlenmez.
- **Doğrulama:** her gün değişen depolarda `git fsck --connectivity-only`, pazar günleri bütün depolarda tam `git fsck` çalışır. Release dosyaları GitHub'ın verdiği sha256 değeriyle karşılaştırılır; uymayan dosya kaydedilmez.
- **Token (isteğe bağlı):** yalnızca kullanıcı adıyla herkese açık repolar yedeklenir. Özel repolar için GitHub'da salt okunur bir *fine-grained* token oluşturun (Repository access: *All repositories*; Permissions: *Contents*, *Issues*, *Pull requests* → *Read-only*) ve Ayarlar'a yapıştırın. Token ayrıca GitHub'ın saatlik istek sınırını 60'tan 5000'e çıkarır; sınıra takılan yedek bir sonraki çalışmada kaldığı yerden devam eder. Token `/etc/serverhealth/github-token` dosyasında yalnızca root'un okuyabileceği şekilde durur, panelde ya da kayıtlarda hiç görünmez; git'e komut satırıyla değil ortam değişkeniyle verilir.
- **Yetkiler:** yedekleme `serverhealth-github.service` ile, kendi yetkisiz kullanıcısıyla (`serverhealth-backup`) çalışır ve yalnızca yedek klasörüne yazabilir. Klasör yoksa üst klasörü var olduğu sürece oluşturulur; disk bağlı değilse yedek sistem diskine yazılmaz, hata verir.
- **Geri yükleme:** `git clone /mnt/disk/github-yedek/<kullanıcı>/<repo>/kod.git` ile çalışma kopyası çıkarılır; GitHub'a ya da başka bir yere bütünüyle göndermek için `git push --mirror <yeni-adres>` kullanılır.
- Gereksinim: `git`. Git LFS dosyaları yedeklenmez.

## Yapay zekâ komutları

Yapay zekâ sayfasındaki **Komut çalıştırma** anahtarı açıkken model, sorunları araştırmak için sunucuda komut çalıştırabilir. Anahtar terminal açık değilse kullanılamaz.

- Komutlar terminal için seçilen kullanıcıyla ve terminal olmadan çalışır. Okuma komutları en fazla 30 saniye (`terminal.commandTimeoutSeconds`), onaylı komutlar en fazla 5 dakika (`terminal.approvedTimeoutSeconds`) sürebilir.
- **sudo:** Onay kutusundaki **sudo ile çalıştır** seçeneği (apt, systemctl restart gibi root isteyen komutlarda kendiliğinden işaretli gelir) sudo şifresini sorar. Komut `&&` ile bağlı en fazla 4 basit adımdan oluşabilir (adımların başındaki `sudo` isteğe bağlıdır); boru, yönlendirme, `;` ve sudo seçenekleri olamaz. Her adım ayrı bir `sudo -k -S` ile çalışır ve şifre yalnızca sudo'nun girişine verilir. Şifre günlüğe, sohbet kaydına ya da modele girmez. Daha karmaşık root komutlarını Terminal sayfasında çalıştırın. Şifre ağda panelle aynı yoldan gittiği için bunu yalnızca HTTPS ya da Tailscale gibi şifreli bir bağlantıda kullanın.
- Yalnızca bilgi okuyan bilinen komutlar (`journalctl`, `systemctl status`, `lsblk`, `df`, `dmesg`, `nvidia-smi`, `ls`, `cat`…) **onaysız** çalışır. Yönlendirme (`>`), zincirleme (`;`, `&&`), alt kabuk, joker karakter, `sudo` ya da bilinmeyen bir seçenek içeren her komut ve bir şeyi değiştiren her komut sohbette **Çalıştır / Reddet** düğmeleriyle onayınızı bekler. Kural panelde uygulanır; tarayıcı onay vermeden bu komutlar çalışmaz.
- Komutlar ayrı bir systemd soketi (`/run/serverhealth-exec.sock`) üzerinden, terminalle aynı kullanıcıyla çalışan kısa ömürlü bir servisle yürütülür. Her komut `journalctl -u serverhealth` günlüğüne yazılır.
- Komut çıktıları ve sistem kayıtları modele veri olarak verilir. Küçük modeller yanılabilir; onay isteyen komutları çalıştırmadan önce okuyun.

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
- **Konteynerler sayfası** Docker soketini panele açmaz; yalnızca listeleme ve başlat/durdur/yeniden başlat yapabilen, yetkisiz kısıtlanmış bir root yardımcısı kullanır (bkz. [Konteynerler](#konteynerler)).
- **Docker:** Docker soketine erişebilen herkes fiilen root yetkisine sahiptir. `--docker` seçeneği servis kullanıcısını `docker` grubuna ekler. Panel yalnızca konteyner listesini okur, ama uygulamada bir açık bulunursa bu yetki kötüye kullanılabilir. Gerçekten ihtiyacınız varsa açın.
- Süreç komut satırları bazen parola içerebilir (ör. `mysql -pGizli`). Bunu istemiyorsanız `processes.showCommandLine` değerini `false` yapın.
- Ağ sayfasındaki port kartı hangi sürecin dinlediğini göstermez. Bu bilgi Güvenlik sayfasında, root'a ait salt okunur sorgu yardımcısı üzerinden gelir (bkz. [Disk alanı, günlükler ve güvenlik](#disk-alanı-günlükler-ve-güvenlik)).
- **Terminal:** panelden açılan terminal, seçilen kullanıcının yapabildiği her şeyi yapabilir. Panel şifresini bilen biri bu kullanıcının kabuğuna erişir; güçlü bir panel şifresi kullanın, ihtiyacınız yoksa terminali kapalı tutun. Ayrıntılar: [Terminal](#terminal).
- **Yapay zekâ:** sohbet ve model işlemleri yalnızca bu makinedeki Ollama'ya gider. Sohbetler panelin durum klasöründe yalnızca panel kullanıcısının okuyabileceği dosyalarda (0600) saklanır; komut çıktıları dahildir, sudo şifreleri hiçbir zaman kaydedilmez. En fazla 200 sohbet tutulur, eskiler silinir.

## Sorun giderme

| Belirti | Çözüm |
| --- | --- |
| Servis başlamıyor | `journalctl -u serverhealth -n 50`: yapılandırma hataları burada satır satır yazılır |
| `Port 8080 başka bir uygulama tarafından kullanılıyor` | `config.json` içinde başka bir `port` seçin |
| Servisler kartında `systemctl hatası` | Birim adlarını `systemctl status AD` ile kontrol edin |
| Docker kartında `erişim izni yok` | `sudo ./deploy/install.sh --docker` çalıştırın |
| Yedekler sayfasında `GitHub yedek servisi kurulu değil` | `sudo ./deploy/install.sh` ile kurulumu güncelleyin; ayrıntı: `journalctl -u serverhealth-github` |
| Depolama, Günlükler ya da Güvenlik sayfasında `sorgu yardımcısı kurulu değil` | Kurulumu güncelleyin: `sudo ./deploy/install.sh` (ayrıntı: `journalctl -u 'serverhealth-query@*'`) |
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
