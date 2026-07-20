/**
 * engine.js — Shared RP Engine
 * sharedrpengine repo → cesurakincan25-design/sharedrpengine
 *
 * Config değerleri window.RPCONFIG'den okunur:
 *   RPCONFIG.tableName     — Firestore koleksiyonu ('nyc_db', 'tokyo_db', 'tokyo_2_db')
 *   RPCONFIG.firebaseConfig — Firebase config objesi (window._fbDb init için)
 *   RPCONFIG.storageKey    — localStorage anahtarı ('nyc_db_v10' vs)
 *   RPCONFIG.storageLegacy — eski localStorage anahtarı (migration için)
 *   RPCONFIG.sfxKey        — SFX mute localStorage anahtarı
 *   RPCONFIG.langKey       — dil tercihi localStorage anahtarı
 *   RPCONFIG.themeKey      — tema localStorage anahtarı
 *   RPCONFIG.playerKey     — aktif oyuncu localStorage anahtarı
 *   RPCONFIG.players       — [{id, name, role, color}] oyuncu listesi
 *   RPCONFIG.seedDB        — başlangıç veritabanı objesi
 *   RPCONFIG.bootMode      — 'splash' (NYC) veya 'player-select' (TOKYO)
 *   RPCONFIG.universe      — evren adı string
 */


// Config guard
if (!window.RPCONFIG) {
  throw new Error('[engine] window.RPCONFIG bulunamadı! config.js yüklendi mi?');
}
var CFG = window.RPCONFIG;

// Firebase SDK (CDN'den yüklenir — index.html'de script tag gerekli)
// Config'den al
var FB_COLLECTION = CFG.tableName; // 'nyc_db', 'tokyo_db', 'tokyo_2_db'
var FB_BACKUP_COL = CFG.tableName + '_backups';
var FB_AUDIT_COL  = CFG.tableName + '_audit_logs';

// Oyuncu listesi - NYC_PLAYERS yerine config'den oku
window.NYC_PLAYERS = CFG.players || [];

// Global değişkenler
var DB = {};
var activeFilters = {
  org: new Set(['all']),
  threat: new Set(['all']),
  heat: new Set(['all']),
  player: 'all',
  search: ''
};
var currentLang = 'tr';
var currentOpenedChar = null;


// ── FIREBASE SYNC ──────────────────────────────────────────────────────────
// Firebase SDK CDN üzerinden yüklenir (index.html'de script tag gerekli)
// window._fbDb objesi config.js'de init edilir

var SupaSync = {
    _saving: false,
    _pendingSave: false,
    _lastRemoteHash: null,
    _pollInterval: null,
    _unsubscribe: null,

    // Firebase'den Firestore db al
    _db() {
        return window._fbDb;
    },

    // Ana dokümanı çek
    async load() {
        try {
            const db = this._db();
            if(!db) throw new Error('Firebase init olmadı');
            const { doc, getDoc } = window._fbFirestore;
            const ref = doc(db, FB_COLLECTION, 'main');
            const snap = await getDoc(ref);
            if(snap.exists()) {
                const d = snap.data();
                if(d.data && Object.keys(d.data).length > 0) {
                    return { data: d.data, updatedAt: d.updated_at, updatedBy: d.updated_by };
                }
            }
            return null;
        } catch(e) {
            console.warn('[FireSync] Load failed:', e.message);
            return null;
        }
    },

    // Firestore'a veri yaz
    async save(data, operator) {
        const charCount = (data && data.characters) ? data.characters.length : 0;
        const orgCount  = (data && data.organizations) ? data.organizations.length : 0;
        const vehCount  = (data && data.vehicles) ? data.vehicles.length : 0;
        if(!data || (charCount === 0 && orgCount === 0 && vehCount === 0)) {
            console.warn('[FireSync] Boş data yazma engellendi');
            return;
        }
        if(this._saving) { this._pendingSave = true; return; }
        this._saving = true;
        const saveTimestamp = new Date().toISOString();
        try {
            const db = this._db();
            const { doc, setDoc } = window._fbFirestore;
            const ref = doc(db, FB_COLLECTION, 'main');
            await setDoc(ref, {
                data: data,
                updated_by: operator || window.currentOperator || 'SYSTEM',
                updated_at: saveTimestamp
            });
            SupaSync._lastSavedAt = saveTimestamp;
            SupaSync._lastRemoteHash = saveTimestamp;
            SupaSync.updateIndicator('saved');
            setTimeout(() => SupaSync.takeBackup(data, operator || window.currentOperator || window.currentPlayer?.name), 500);
        } catch(e) {
            console.error('[FireSync] Save failed:', e.message);
            SupaSync.updateIndicator('error');
        } finally {
            this._saving = false;
            if(this._pendingSave) {
                this._pendingSave = false;
                setTimeout(() => SupaSync.save(DB, window.currentOperator), 1000);
            }
        }
    },

    // Realtime listener ile polling yerine anlık güncelleme
    startPolling(intervalMs) {
        try {
            const db = this._db();
            if(!db) return;
            const { doc, onSnapshot } = window._fbFirestore;
            const ref = doc(db, FB_COLLECTION, 'main');
            if(this._unsubscribe) this._unsubscribe();
            this._unsubscribe = onSnapshot(ref, (snap) => {
                if(!snap.exists()) return;
                const d = snap.data();
                const remoteHash = d.updated_at || '';
                if(!this._lastRemoteHash) { this._lastRemoteHash = remoteHash; return; }
                if(remoteHash === this._lastRemoteHash) return;
                this._lastRemoteHash = remoteHash;
                const remoteOp   = d.updated_by || 'UNKNOWN';
                const localOp    = window.currentOperator || 'SYSTEM';
                const remoteTime = new Date(d.updated_at || 0).getTime();
                const lastSaved  = new Date(this._lastSavedAt || 0).getTime();
                const isMine     = remoteOp === localOp;
                const isAfter    = remoteTime > lastSaved + 2000;
                if(!isMine && isAfter && d.data) {
                    const remoteChars = (d.data.characters || []).filter(c => !c.isArchived);
                    const localChars  = (DB.characters || []).filter(c => !c.isArchived);
                    if(remoteChars.length >= localChars.length) {
                        const parsed = Storage.migrateDB(d.data);
                        Object.assign(DB, parsed);
                        Storage.saveLocal(DB);
                        try { UI.renderAll(); } catch(e) {}
                        try { Admin.refreshAuditPanel(); } catch(e) {}
                        SupaSync.updateIndicator('synced');
                        SupaSync.showSyncToast(remoteOp);
                    } else {
                        console.warn('[FireSync] Remote has fewer chars, skipping');
                        SupaSync.updateIndicator('synced');
                    }
                }
            }, (err) => { console.warn('[FireSync] Snapshot error:', err.message); });
        } catch(e) { console.warn('[FireSync] startPolling error:', e.message); }
    },

    updateIndicator(state) {
        const el = document.getElementById('sync-indicator');
        if(!el) return;
        const states = {
            saving:  { color: '#f59e0b', icon: 'fa-spinner fa-spin', text: 'SYNCING...' },
            saved:   { color: '#00ff88', icon: 'fa-cloud',           text: 'SYNCED'    },
            error:   { color: '#ff2a2a', icon: 'fa-exclamation-triangle', text: 'SYNC ERR' },
            synced:  { color: '#a855f7', icon: 'fa-sync',            text: 'UPDATED'   },
            offline: { color: '#6b7280', icon: 'fa-wifi-slash',      text: 'LOCAL'     },
            backup:  { color: '#06b6d4', icon: 'fa-shield-alt',      text: 'AUTO BACKUP' }
        };
        const s = states[state] || states.saved;
        el.style.color = s.color;
        el.innerHTML = '<i class="fas ' + s.icon + ' mr-1"></i>' + s.text;
    },

    showSyncToast(operator) {
        try { if(typeof showSaveToast === 'function') showSaveToast('⟳ ' + operator + ' güncelledi — yenilendi'); } catch(e) {}
    }
};

// ── BACKUP SİSTEMİ (Firebase) ──────────────────────────────────────────
SupaSync.takeBackup = async function(data, operator) {
    try {
        const db = SupaSync._db();
        if(!db) return;
        const { collection, addDoc, query, orderBy, limit, getDocs, deleteDoc, doc } = window._fbFirestore;
        const charCount = (data.characters || []).filter(c => !c.isArchived).length;
        // Son backup kontrol - 5 dakika içinde aynı sayıda ise atla
        const q = query(collection(db, FB_BACKUP_COL), orderBy('created_at', 'desc'), limit(1));
        const snap = await getDocs(q);
        if(!snap.empty) {
            const last = snap.docs[0].data();
            const lastTime = new Date(last.created_at || 0).getTime();
            if(charCount === (last.char_count || 0) && Date.now() - lastTime < 5 * 60 * 1000) return;
            if(charCount < (last.char_count || 0)) {
                console.warn('[Backup] Karakter sayısı düştü! ' + last.char_count + ' → ' + charCount);
            }
        }
        // Backup yaz
        await addDoc(collection(db, FB_BACKUP_COL), {
            created_at: new Date().toISOString(),
            saved_by: operator || window.currentOperator || 'SYSTEM',
            char_count: charCount,
            data: data
        });
        // 20'den fazlaysa eskiyi sil
        const allSnap = await getDocs(query(collection(db, FB_BACKUP_COL), orderBy('created_at', 'desc')));
        if(allSnap.docs.length > 20) {
            const toDelete = allSnap.docs.slice(20);
            for(const d of toDelete) await deleteDoc(doc(db, FB_BACKUP_COL, d.id));
        }
        console.log('[Backup] ✓ Yedek alındı. Karakter:', charCount);
        SupaSync.updateIndicator('backup');
        setTimeout(() => SupaSync.updateIndicator('saved'), 3000);
    } catch(e) { console.warn('[Backup] Yedek alınamadı:', e.message); }
};

SupaSync.listBackups = async function() {
    try {
        const db = SupaSync._db();
        const { collection, query, orderBy, limit, getDocs } = window._fbFirestore;
        const q = query(collection(db, FB_BACKUP_COL), orderBy('created_at', 'desc'), limit(20));
        const snap = await getDocs(q);
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch(e) { return []; }
};

SupaSync.restoreBackup = async function(backupId) {
    try {
        const db = SupaSync._db();
        const { doc, getDoc } = window._fbFirestore;
        const snap = await getDoc(doc(db, FB_BACKUP_COL, backupId));
        if(!snap.exists()) return false;
        const backupData = snap.data().data;
        await SupaSync.takeBackup(DB, 'RESTORE_PRE_' + (window.currentOperator || 'SYSTEM'));
        const parsed = Storage.migrateDB(backupData);
        Object.assign(DB, parsed);
        Storage.saveLocal(DB);
        await SupaSync.save(DB, window.currentOperator);
        try { UI.renderAll(); } catch(e) {}
        return true;
    } catch(e) { console.error('[Backup] Restore hatası:', e.message); return false; }
};

SupaSync.pushAuditLog = async function(entry) {
    try {
        const db = SupaSync._db();
        const { collection, addDoc } = window._fbFirestore;
        await addDoc(collection(db, FB_AUDIT_COL), {
            log_id: entry.id, type: entry.type, message: entry.message,
            operator: entry.operator || 'SYSTEM',
            record_id: entry.recordId || null,
            ts: entry.timestamp || new Date().toISOString()
        });
    } catch(e) {}
};

SupaSync.fetchAuditLogs = async function() {
    try {
        const db = SupaSync._db();
        const { collection, query, orderBy, limit, getDocs } = window._fbFirestore;
        const q = query(collection(db, FB_AUDIT_COL), orderBy('ts', 'desc'), limit(200));
        const snap = await getDocs(q);
        return snap.docs.map(d => d.data());
    } catch(e) { return null; }
};

window.SupaSync = SupaSync;
var SFX = {
   ctx: null,
   isMuted: localStorage.getItem(CFG.sfxKey) === 'true',
   init() {
    if (!this.ctx) {
     this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
     this.ctx.resume();
    }
    this.updateUI();
   },
   toggleMute() {
    this.isMuted = !this.isMuted;
    localStorage.setItem(CFG.sfxKey, this.isMuted);
    this.updateUI();
   },
   updateUI() {
    const btn = document.getElementById('sfx-toggle-btn');
    if(btn) {
     btn.innerHTML = this.isMuted ? '<i class="fas fa-volume-mute text-cyber-red"></i>' : '<i class="fas fa-volume-up text-cyber-blue"></i>';
    }
   },
   playTone(freq, type, duration, vol=0.01, slideFreq=null) {
    if (this.isMuted || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    if (slideFreq) {
     osc.frequency.exponentialRampToValueAtTime(slideFreq, this.ctx.currentTime + duration);
    }
    gain.gain.setValueAtTime(vol, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration);
   },
   hover() { this.playTone(1200, 'sine', 0.03, 0.005); },
   click() { this.playTone(600, 'square', 0.05, 0.02, 200); },
   decrypt() {
    if (this.isMuted || !this.ctx) return;
    for(let i=0; i<6; i++) {
     setTimeout(() => this.playTone(Math.random() * 800 + 800, 'square', 0.04, 0.01), i * 40);
    }
   },
   warning() {
    if (this.isMuted || !this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(100, this.ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(150, this.ctx.currentTime + 0.5);
    osc.frequency.linearRampToValueAtTime(100, this.ctx.currentTime + 1.0);
    gain.gain.setValueAtTime(0.03, this.ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + 1.5);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + 1.5);
   },
   bind() {
    document.addEventListener('mouseover', (e) => {
     if(e.target.closest('.cyber-card, .hover-sfx, .cyber-radio, .cursor-pointer')) this.hover();
    });
    document.addEventListener('click', (e) => {
     if(e.target.closest('.cyber-card, .click-sfx, .cyber-radio, .cursor-pointer')) this.click();
    });
   }
  };

var i18n = {
   en: {
    title: "Surveillance Net", nav_profiles: "Profiles", nav_syndicates: "Syndicates", nav_vehicles: "Vehicles", nav_properties: "Assets & Fronts", nav_admin: "System Admin",
    nav_contracts: "Contracts", nav_cases: "Case Files", nav_logs: "Live Logs", nav_radar: "Radar / Map",
    nav_equipments: "Equipments", head_equipments: "Arsenal & Cyberware", eq_editor: "EQUIPMENT EDITOR", eq_intel: "TECH INTEL", no_equipments: "No registered gear.",
    filter_org: "FILTER.ORG", filter_threat: "FILTER.THREAT", filter_heat: "FILTER.HEAT (WANTED)",
    all_records: "ALL RECORDS", all_levels: "ALL", all_status: "ALL",
    search_ph: "Query identity, alias, or asset...", db_status: "DB.STATUS:", online: "ONLINE", clearance: "CLEARANCE: LVL 5",
    head_profiles: "Target Profiles", head_syndicates: "Syndicates & Corps", head_vehicles: "Registered Vehicles", head_properties: "Classified Assets",
    head_contracts: "Bounty & Contracts", head_cases: "Classified Case Files", head_radar: "Satellite Radar Tracking",
    matches: "Matches", threat: "THREAT", status: "STATUS", active: "Active", deceased: "Deceased", incarcerated: "Incarcerated", mia: "MIA", heat: "HEAT",
    territory: "TERRITORY", records: "RECORDS", operatives: "Operatives", plate: "PLATE", owner: "OWNER", specs: "SPECS",
    none: "NONE", unregistered: "UNREGISTERED", classified: "CLASSIFIED", loc: "LOC", type: "TYPE",
    psych_intel: "PSYCHOLOGICAL / HISTORICAL INTEL", reg_vehicles: "REGISTERED VEHICLES", known_assets: "KNOWN ASSETS",
    no_vehicles: "No registered vehicles.", no_assets: "No registered assets.", veh_intel: "VEHICLE INTEL", asset_intel: "ASSET INTEL", asset_details: "ASSET DETAILS",
    contact_owner: "PRIMARY CONTACT / OWNER", no_alias: "NO ALIAS", ext_link: "External Intel Link", deep_research: "START DEEP RESEARCH",
    org_editor: "SYNDICATE EDITOR", org_name: "Syndicate Name", org_color: "Theme Color (Hex)", org_terr: "Territories (Comma separated)", org_logo: "Logo URL", org_desc: "Description",
    relationships: "Relationships", known_associates: "KNOWN ASSOCIATES", 
    omega: "OMEGA", extreme: "EXTREME", high: "HIGH", medium: "MED", low: "LOW", clean: "CLEAN", most_wanted: "WANTED",
    stat_total: "TOTAL ENTITIES", stat_active: "ACTIVE / DECEASED", stat_critical: "CRITICAL THREATS", stat_wanted: "MOST WANTED",
    contract_editor: "CONTRACT EDITOR", con_target: "Target Name", con_issuer: "Issuer / Client", con_reward: "Bounty / Reward", con_status: "Status", con_assigned: "Assigned Operative", con_details: "Contract Details",
    case_editor: "CASE FILE EDITOR", case_title: "Case Title", case_date: "Date / Period", case_tags: "Tagged Profiles", case_notes: "Case Intel / Notes",
    log_editor: "LIVE FEED EDITOR", log_time: "Timestamp", log_type: "Type", log_msg: "Message", live_feed: "LIVE FEED", radar_hint: "Click on map to copy coordinates."
   },
   tr: {
    title: "Gözetim Ağı", nav_profiles: "Profiller", nav_syndicates: "Sendikalar", nav_vehicles: "Araçlar", nav_properties: "Mülkler & Cepheler", nav_admin: "Sistem Yöneticisi",
    nav_contracts: "Kontratlar", nav_cases: "Vaka Dosyaları", nav_logs: "Canlı Akış", nav_radar: "Radar / Harita",
    nav_equipments: "Teçhizatlar", head_equipments: "Arsenal & Siber Donanım", eq_editor: "TEÇHİZAT DÜZENLEYİCİ", eq_intel: "TEKNOLOJİ İSTİHBARATI", no_equipments: "Kayıtlı teçhizat bulunamadı.",
    filter_org: "FİLTRE.ORG", filter_threat: "FİLTRE.TEHDİT", filter_heat: "FİLTRE.ARANMA", 
    all_records: "TÜM KAYITLAR", all_levels: "TÜMÜ", all_status: "TÜMÜ",
    search_ph: "Kimlik, kod adı veya mülk sorgula...", db_status: "VT.DURUMU:", online: "ÇEVRİMİÇİ", clearance: "YETKİ: Svy 5",
    head_profiles: "Hedef Profilleri", head_syndicates: "Sendikalar & Şirketler", head_vehicles: "Kayıtlı Araçlar", head_properties: "Gizli Mülkler",
    head_contracts: "Ödül & Kontratlar", head_cases: "Gizli Vaka Dosyaları", head_radar: "Uydu / Radar Takibi",
    matches: "Eşleşme", threat: "TEHDİT", status: "DURUM", active: "Aktif", deceased: "Ölü", incarcerated: "Hapiste", mia: "Kayıp", heat: "ARANMA",
    territory: "BÖLGE", records: "KAYITLAR", operatives: "Ajan", plate: "PLAKA", owner: "SAHİBİ", specs: "ÖZELLİKLER",
    none: "YOK", unregistered: "KAYITSIZ", classified: "GİZLİ", loc: "KONUM", type: "TÜR",
    psych_intel: "PSİKOLOJİK / TARİHİ İSTİHBARAT", reg_vehicles: "KAYITLI ARAÇLAR", known_assets: "BİLİNEN MÜLKLER",
    no_vehicles: "Kayıtlı araç bulunamadı.", no_assets: "Kayıtlı mülk bulunamadı.", veh_intel: "ARAÇ İSTİHBARATI", asset_intel: "MÜLK İSTİHBARATI", asset_details: "MÜLK DETAYLARI",
    contact_owner: "BİRİNCİL KİŞİ / SAHİBİ", no_alias: "KOD ADI YOK", ext_link: "Dış İstihbarat Bağlantısı", deep_research: "DERİN ARAŞTIRMA BAŞLAT",
    org_editor: "SENDİKA DÜZENLEYİCİ", org_name: "Sendika/Şirket Adı", org_color: "Tema Rengi (Hex)", org_terr: "Bölgeler (Virgülle ayırın)", org_logo: "Logo URL", org_desc: "Açıklama",
    relationships: "İlişki / Bağlantılar", known_associates: "BİLİNEN BAĞLANTILAR", 
    omega: "OMEGA", extreme: "EKSTREM", high: "YÜKSEK", medium: "ORTA", low: "DÜŞÜK", clean: "TEMİZ", most_wanted: "BÜLTEN",
    stat_total: "TOPLAM KAYIT", stat_active: "AKTİF / ÖLÜ", stat_critical: "KRİTİK TEHDİTLER", stat_wanted: "KIRMIZI BÜLTEN",
    contract_editor: "KONTRAT DÜZENLEYİCİ", con_target: "Hedef Adı", con_issuer: "İşveren / Müşteri", con_reward: "Ödül", con_status: "Durum", con_assigned: "Atanan Ajan", con_details: "Kontrat Detayları",
    case_editor: "VAKA DOSYASI DÜZENLEYİCİ", case_title: "Vaka Başlığı", case_date: "Tarih / Dönem", case_tags: "Etiketli Profiller", case_notes: "Vaka İstihbaratı / Notlar",
    log_editor: "CANLI AKIŞ DÜZENLEYİCİ", log_time: "Zaman Damgası", log_type: "Kategori", log_msg: "Mesaj", live_feed: "CANLI AKIŞ", radar_hint: "Koordinat kopyalamak için haritaya tıklayın."
   }
  };

  

  

  
  function showSaveToast(msg,isError){
   try{
    const t=document.getElementById('save-toast');
    const m=document.getElementById('save-toast-msg');
    if(!t||!m)return;
    m.textContent=msg||'KAYDEDİLDİ';
    if(isError){t.classList.add('error');}else{t.classList.remove('error');}
    t.classList.add('show');
    if(!isError)try{SFX.click();}catch(e){}
    clearTimeout(t._tid);
    t._tid=setTimeout(function(){try{t.classList.remove('show');}catch(e){}},2500);
   }catch(e){console.warn('toast:',e);}
  }

  function formatAuditTime() {
   return new Date().toLocaleString('tr-TR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
   });
  }
  

  function renderPlayerSelectGrid(){
    const grid=document.getElementById('player-select-grid');if(!grid)return;
    grid.innerHTML=NYC_PLAYERS.map(p=>`<button class="player-select-btn glass-panel p-4 border-2 border-transparent cursor-pointer click-sfx flex flex-col items-center gap-2 transition-all" style="color:${p.color}" data-player-id="${p.id}" onclick="selectPlayer('${p.id}')"><div class="w-12 h-12 rounded-full border-2 flex items-center justify-center font-display font-black text-xl" style="border-color:${p.color};background:${p.color}18">${p.name[0]}</div><span class="font-mono text-xs tracking-widest">${p.name.toUpperCase()}</span></button>`).join('');
    if(window.currentPlayer){document.querySelectorAll('.player-select-btn').forEach(b=>{if(b.dataset.playerId===window.currentPlayer.id){b.style.borderColor=window.currentPlayer.color;b.style.background=window.currentPlayer.color+'18';}});showLoginSelection(window.currentPlayer);}
  }
  function selectPlayer(id){
    const p=NYC_PLAYERS.find(x=>x.id===id);if(!p)return;
    window._selectedPlayer=p;
    document.querySelectorAll('.player-select-btn').forEach(b=>{b.style.borderColor=b.dataset.playerId===id?p.color:'transparent';b.style.background=b.dataset.playerId===id?p.color+'22':'';});
    showLoginSelection(p);
  }
  function showLoginSelection(p){
    // NYC ve TOKYO admin modal id'lerini destekle
    const info=document.getElementById('login-selected-info')||document.getElementById('admin-login-selected-info');
    const name=document.getElementById('login-selected-name')||document.getElementById('admin-login-selected-name');
    const btn=document.getElementById('login-confirm-btn')||document.getElementById('admin-login-confirm-btn');
    if(info)info.classList.remove('hidden');
    if(name){name.textContent=p.name.toUpperCase();name.style.color=p.color;}
    if(btn){btn.removeAttribute('disabled');btn.style.borderColor=p.color;btn.style.color=p.color;}
  }
  function updatePlayerIndicator(){
    const el=document.getElementById('player-indicator');if(!el)return;
    const p=window.currentPlayer;
    if(p){el.textContent=p.name.toUpperCase();el.style.color=p.color;el.style.borderColor=p.color+'50';}
    else{el.textContent='GİRİŞ';el.style.color='#6b7280';el.style.borderColor='#374151';}
  }
  window.currentOperator = 'SYSTEM';
var Storage = {
   KEY: CFG.storageKey,
   KEY_LEGACY: CFG.storageLegacy,

   migrateDB(parsed) {
    const version = parseFloat(parsed.metadata?.version || '0');
    
    

    if(!parsed.characters) parsed.characters = [];
    parsed.characters.forEach(c => {
     if(!c.relationships) c.relationships = [];
     if(!c.heatLevel) c.heatLevel = 'Clean';
     if(c.isClassified === undefined) c.isClassified = false;
     if(c.isLocked    === undefined) c.isLocked    = false;
     if(c.isArchived  === undefined) c.isArchived  = false;
     if(c.profileType === undefined) c.profileType = 'main';
     if(c.themeSong   === undefined) c.themeSong   = '';
     if(c.mapX === undefined) c.mapX = null;
     if(c.mapY === undefined) c.mapY = null;
     

     if(!c.organizations) {
      c.organizations = c.organization ? [c.organization] : [];
     }
    });
    

    (parsed.contracts||[]).forEach(c => {
     if(!c.priority)     c.priority     = 'Medium';
     if(!c.suspects)     c.suspects     = [];
     if(!c.evidence)     c.evidence     = [];
     if(!c.timeline)     c.timeline     = [];
     if(!c.linkedCases)  c.linkedCases  = [];
     if(!c.linkedOrgs)   c.linkedOrgs   = [];
     if(!c.briefing)     c.briefing     = '';
     if(!c.outcome)      c.outcome      = '';
     if(!c.location)     c.location     = '';
    });
    parsed.characters.forEach(c => {
     if(!c.organizations) {
      c.organizations = c.organization ? [c.organization] : [];
     }
     if(c.statusNote === undefined) c.statusNote = '';
     if(!c.bankAccounts) c.bankAccounts = [];
     if(c.playerId === undefined) c.playerId = '';
     if(c.player === undefined) c.player = '';
     

     if(c.reputation === undefined) {
      c.reputation = {
       global: 0,           

       level: 'Unknown',    

       orgs: {},            

       notes: ''            

      };
     }
    });

    

    if(!parsed.organizations) parsed.organizations = [];
    (parsed.organizations).forEach(o => {
     if(!o.memberRoles) o.memberRoles = {};
     if(!o.members)     o.members     = [];
     if(!o.threatLevel) o.threatLevel = 'Low';
     if(!o.heatLevel)   o.heatLevel   = 'Clean';
    });
    if(!parsed.vehicles) parsed.vehicles = [];
    parsed.vehicles.forEach(v => {
     if(!v.heatLevel) v.heatLevel = 'Clean';
     if(v.mapX === undefined) v.mapX = null;
     if(v.mapY === undefined) v.mapY = null;
    });

    

    if(!parsed.properties) parsed.properties = [];
    parsed.properties.forEach(p => {
     if(p.mapX === undefined) p.mapX = null;
     if(p.mapY === undefined) p.mapY = null;
    });

    

    if(!parsed.organizations) parsed.organizations = [];
    parsed.organizations.forEach(o => {
     o.logo     = o.logo     ?? '';
     o.banner   = o.banner   ?? '';
     o.tags     = o.tags     ?? [];
     o.status   = o.status   ?? 'Active';
     o.memberCount = o.memberCount ?? null;
     o.hierarchy   = o.hierarchy   ?? '';
     o.threatLevel = o.threatLevel ?? 'Low';
     if(!o.members) o.members = [];
     if(!o.memberRoles) o.memberRoles = {};
     o.members.forEach(m => { if(!m.role) m.role = ''; });
     o.heatLevel   = o.heatLevel   ?? 'Clean';
     o.linkedProperties = o.linkedProperties ?? [];
     o.linkedVehicles   = o.linkedVehicles   ?? [];
     o.links    = o.links    ?? [];
     o.notes    = o.notes    ?? '';
    });

    

    if(!parsed.contracts) parsed.contracts = [];
    parsed.contracts.forEach(con => {
     con.riskLevel    = con.riskLevel    ?? 'Medium';
     con.deadline     = con.deadline     ?? '';
     con.linkedCases  = con.linkedCases  ?? [];
     con.linkedOrgs   = con.linkedOrgs   ?? [];
     con.notes        = con.notes        ?? '';
     con.tags         = con.tags         ?? [];
     con.links        = con.links        ?? [];
     con.link         = con.link         ?? '';
     con.archived     = con.archived     ?? false;
    });

    

    if(!parsed.cases) parsed.cases = [];
    parsed.cases.forEach(cf => {
     cf.status        = cf.status        ?? 'Open';
     cf.priority      = cf.priority      ?? 'Medium';
     cf.suspects      = cf.suspects      ?? (cf.tags ? [...cf.tags] : []);
     cf.relatedOrgs   = cf.relatedOrgs   ?? [];
     cf.linkedContracts = cf.linkedContracts ?? [];
     cf.assignedAgents  = cf.assignedAgents  ?? [];
     cf.evidence      = cf.evidence      ?? [];
     cf.timeline      = cf.timeline      ?? [];
     cf.externalRefs  = cf.externalRefs  ?? [];
     cf.notes         = cf.notes         ?? '';
     cf.archived      = cf.archived      ?? false;
    });

    if(!parsed.equipments) parsed.equipments = [];
    if(!parsed.logs) parsed.logs = [];
    if(!parsed.auditLogs) parsed.auditLogs = [];
    if(!parsed.events)    parsed.events = [];
    parsed.events.forEach(ev => {
     ev.id        = ev.id        || `ev_${Date.now()}_${Math.random().toString(36).slice(2)}`;
     ev.title     = ev.title     || '';
     ev.date      = ev.date      || '';
     ev.desc      = ev.desc      || '';
     ev.icon      = ev.icon      || 'bolt';
     ev.mapX      = ev.mapX      ?? null;
     ev.mapY      = ev.mapY      ?? null;
     ev.color     = ev.color     || '#a855f7';
     ev.linkedOrgs = ev.linkedOrgs || [];
     ev.linkedChars= ev.linkedChars|| [];
    });
    if(!parsed.events)    parsed.events = [];

    

    if(parsed.metadata) parsed.metadata.version = '10.0';
    else parsed.metadata = { version: '10.0', universe: 'NYC Cyber-Noir RP', lastUpdated: new Date().toISOString() };

    return parsed;
   },

   async initFromSupabase() {
    try {
     const remote = await SupaSync.load();
     if(remote && remote.data && Object.keys(remote.data).length > 0) {
      const parsed = this.migrateDB(remote.data);
      localStorage.setItem(this.KEY, JSON.stringify(parsed));
      SupaSync._lastRemoteHash = remote.updatedAt || '';
      SupaSync._lastSavedAt = remote.updatedAt || new Date().toISOString();
      return parsed;
     }
    } catch(e) {
     console.warn('[Storage.initFromSupabase] Failed, using local:', e);
    }
    return null;
   },
   init() {
    let parsed = null;
    let data = localStorage.getItem(this.KEY);
    if (data) {
     try { parsed = JSON.parse(data); } catch(e) { console.error('V10 parse err:', e); }
    }

    

    if (!parsed) {
     const legacy = localStorage.getItem(this.KEY_LEGACY);
     if (legacy) {
      try {
       parsed = JSON.parse(legacy);
       console.log('[V10] Migrating from legacy save (v8)...');
      } catch(e) { console.error('Legacy parse err:', e); }
     }
    }

    

    if (!parsed && CFG.seedDB && Object.keys(CFG.seedDB).length > 0) {
     parsed = JSON.parse(JSON.stringify(CFG.seedDB));
    }

    if (parsed) {
     parsed = this.migrateDB(parsed);
     // Sadece localStorage'a yaz - Supabase'e dokunma (initFromSupabase zaten halletti)
     try { localStorage.setItem(this.KEY, JSON.stringify(parsed)); } catch(e) {}
     return parsed;
    }

    return null;
   },
   saveLocal(data) {
    try { localStorage.setItem(this.KEY, JSON.stringify(data)); } catch(e) {}
   },
   save(data) { 
    if(data.metadata) {
     data.metadata.lastUpdated = new Date().toISOString();
     const op = window.currentOperator || 'SYSTEM';
     if(op !== 'SYSTEM') data.metadata.lastSavedBy = op;
    }
    // localStorage'a yaz (offline backup)
    try { localStorage.setItem(this.KEY, JSON.stringify(data)); } catch(e) {}
    // Supabase'e async yaz
    try {
     SupaSync.updateIndicator('saving');
     SupaSync.save(data, window.currentOperator);
    } catch(e) { console.warn('[Storage.save] Supabase skip:', e); }
   },
   export(data) {
    const a = document.createElement("a");
    a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
    a.download = `${CFG.universe.replace(/\s+/g,'_').toUpperCase()}_BACKUP_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a); a.click(); a.remove();
   },
   getLang() { return localStorage.getItem(CFG.langKey) || 'tr'; },
   saveLang(l) { localStorage.setItem(CFG.langKey, l); }
  };

  const getSortedChars = () => DB.characters.slice().sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  

  const TAB_ICONS = {
   dashboard: 'fa-users', radar: 'fa-map-marked-alt',
   organizations: 'fa-sitemap', contracts: 'fa-crosshairs',
   cases: 'fa-folder-open', vehicles: 'fa-car',
   properties: 'fa-building', equipments: 'fa-microchip',
   admin: 'fa-terminal'
  };
  const TAB_LABELS = {
   dashboard: 'Profiles', radar: 'Radar', organizations: 'Syndicates',
   contracts: 'Contracts', cases: 'Case Files', vehicles: 'Vehicles',
   properties: 'Assets', equipments: 'Equipment', admin: 'Admin Panel'
  };
  const TAB_COLORS = {
   contracts: 'tab-contracts', cases: 'tab-cases', radar: 'tab-radar',
   equipments: 'tab-equipments', admin: 'tab-admin'
  };

  

  const THEMES = {
   cyber:   { blue:'#00a2ff', red:'#ff2a2a', green:'#00ff66', gold:'#f59e0b', purple:'#b026ff', omega:'#ff0055' },
   crimson: { blue:'#ff6b6b', red:'#ff0000', green:'#ff9f43', gold:'#ffd700', purple:'#ff4757', omega:'#c0392b' },
   matrix:  { blue:'#00ff66', red:'#ff2a2a', green:'#39ff14', gold:'#00ff66', purple:'#00b894', omega:'#00cec9' },
   violet:  { blue:'#a855f7', red:'#ec4899', green:'#8b5cf6', gold:'#f59e0b', purple:'#7c3aed', omega:'#db2777' },
   gold:    { blue:'#f59e0b', red:'#ef4444', green:'#84cc16', gold:'#fbbf24', purple:'#d97706', omega:'#b45309' },
  };
  function applyTheme(name) {
   const t = THEMES[name] || THEMES.cyber;
   const r = document.documentElement.style;
   r.setProperty('--neon-blue',   t.blue);
   r.setProperty('--neon-red',    t.red);
   r.setProperty('--neon-green',  t.green);
   r.setProperty('--neon-gold',   t.gold  || t.blue);
   r.setProperty('--neon-purple', t.purple);
   r.setProperty('--neon-omega',  t.omega);
   localStorage.setItem(CFG.themeKey, name);
   document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === name));
  }
  

var Tabs = {
   stack: [],
   active: null,

   open(tabId, labelOverride) {
    const existing = this.stack.find(t => t.id === tabId);
    if (existing) { this.activate(tabId); return; }
    this.stack.push({
     id: tabId,
     label: labelOverride || TAB_LABELS[tabId] || tabId,
     icon: TAB_ICONS[tabId] || 'fa-circle',
     colorClass: TAB_COLORS[tabId] || ''
    });
    this.activate(tabId);
   },

   activate(tabId) {
    this.active = tabId;
    this.render();
   },

   close(tabId, e) {
    if (e) e.stopPropagation();
    const idx = this.stack.findIndex(t => t.id === tabId);
    if (idx === -1) return;
    this.stack.splice(idx, 1);
    if (this.active === tabId) {
     const next = this.stack[Math.min(idx, this.stack.length - 1)];
     if (next) { this.active = next.id; UI._switchViewOnly(next.id); }
     else { this.active = null; }
    }
    this.render();
   },

   render() {
    const bar = document.getElementById('tab-bar');
    if (!bar) return;
    bar.innerHTML = this.stack.map(t => `
     <div class="tab-item ${TAB_COLORS[t.id]||''} ${this.active === t.id ? 'active' : ''}"
      onclick="Tabs.activate('${t.id}'); UI._switchViewOnly('${t.id}');"
      title="${t.label}">
      <i class="fas ${t.icon} tab-icon"></i>
      <span class="tab-label">${t.label}</span>
      <span class="tab-close" onclick="Tabs.close('${t.id}', event)" title="Close tab">&#x2715;</span>
     </div>`).join('');
    const activeEl = bar.querySelector('.tab-item.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
   },

   init(tabId) {
    if (!this.stack.find(t => t.id === tabId)) {
     this.stack.push({
      id: tabId,
      label: TAB_LABELS[tabId] || tabId,
      icon: TAB_ICONS[tabId] || 'fa-circle',
      colorClass: TAB_COLORS[tabId] || ''
     });
    }
    this.active = tabId;
    this.render();
   }
  };
  

var UI = {
   async bootSequence() {
    // iOS Safari güvenli boot: tüm hatalar yakalanır, initApp her koşulda çalışır
    const self = this;

    // B PLANI: 12 saniye içinde boot bitmezse zorla geç
    const safetyTimer = setTimeout(() => {
     try { self._finishBoot(); } catch(e) { self.initApp(); }
    }, 12000);

    this._finishBoot = function() {
     clearTimeout(safetyTimer);
     const boot = document.getElementById('boot-screen');
     const wrapper = document.getElementById('app-wrapper');
     if(boot) { boot.classList.add('opacity-0'); }
     if(wrapper) wrapper.style.filter = 'brightness(1)';
     setTimeout(() => { if(boot) boot.classList.add('hidden'); }, 800);
     if(!self._appStarted) { self._appStarted = true; self.initApp().catch(e=>console.error(e)); }
    };

    // init-screen gizle
    const initScr = document.getElementById('init-screen');
    if(initScr) {
     initScr.classList.add('opacity-0');
     setTimeout(() => initScr.classList.add('hidden'), 800);
    }

    // SFX: iOS'ta WebAudio kullanıcı etkileşimi olmadan çalışmıyor, hata verirse geç
    try { SFX.init(); } catch(e) { /* iOS ses izni yok, devam */ }

    const boot = document.getElementById('boot-screen');
    if(!boot) { this._finishBoot(); return; }
    boot.classList.remove('hidden');

    const dbVer = (CFG.seedDB?.metadata?.version) ? CFG.seedDB.metadata.version : '10.0';
    const dbDate = (() => {
     try {
      const raw = CFG.seedDB?.metadata?.lastUpdated;
      if(!raw) return null;
      return new Date(raw).toLocaleString('tr-TR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
     } catch(e) { return null; }
    })();
    const dbBy = (() => {
     try { const b = CFG.seedDB?.metadata?.lastSavedBy; return b ? b.toUpperCase() : null; } catch(e) { return null; }
    })();

    const logs = [
     "INITIALIZING NEURAL LINK...",
     "BYPASSING ICE-3 PROTOCOLS...",
     "ESTABLISHING SECURE CONNECTION...",
     "DECRYPTING DATABASE FILES...",
     "LOADING NYC_DB_V2 — V" + dbVer + " DATABASE...",
     "BUILD: 2026.05.15 | OTURUM: 1-15",
     dbDate ? "LAST SYNC: " + dbDate : null,
     dbBy   ? "LAST OPERATOR: " + dbBy : null,
     "NYC_DB_V2 — ACCESS GRANTED."
    ].filter(Boolean);

    const logContainer = document.getElementById('boot-logs');
    if(!logContainer) { this._finishBoot(); return; }

    // Async boot sequence - try/catch ile sarılı
    (async () => {
     try {
      for(let text of logs) {
       try { SFX.hover(); } catch(e) { /* ses yok, devam */ }
       const p = document.createElement('p');
       p.textContent = text;
       logContainer.appendChild(p);
       await new Promise(r => setTimeout(r, 250 + Math.random() * 300));
      }
      try { SFX.decrypt(); } catch(e) {}
      await new Promise(r => setTimeout(r, 400));
     } catch(e) {
      // Async hata → direkt bitir
     }
     self._finishBoot();
    })();
   },

   async initApp() {
    // Supabase'den yükle, sonra localStorage fallback
    let loadedDB = null;
    try {
     loadedDB = await Storage.initFromSupabase();
    } catch(e) {}
    if(!loadedDB) loadedDB = Storage.init();
    if(!loadedDB) {
     // Supabase ve localStorage ikisi de boş - seedDB kullan ama Supabase'e YAZMA
     DB = CFG.seedDB ? JSON.parse(JSON.stringify(CFG.seedDB)) : {
      metadata: { version: "10.0", universe: CFG.universe || "RP", lastUpdated: new Date().toISOString() },
      organizations: [], characters: [], vehicles: [], properties: [], equipments: [], contracts: [], cases: [], logs: []
     };
     try { localStorage.setItem(Storage.KEY, JSON.stringify(DB)); } catch(e) {}
    } else {
     DB = loadedDB;
    }

    currentLang = Storage.getLang();
    this.updateLanguageUI();
    SFX.bind();
    

    document.addEventListener('keydown', (e) => {
     const tag = document.activeElement?.tagName?.toLowerCase();
     const isTyping = ['input','textarea','select'].includes(tag);

     

     if (e.key === 'Escape') {
      UI.closeOrgModal();
      UI.closeCaseModal();
      UI.closeContractModal();
      UI.closeAllModals();
      return;
     }

     

     if (isTyping) return;

     const tabs = ['dashboard','radar','organizations','contracts','cases','vehicles','properties','equipments'];

     

     if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const current = Tabs.active;
      const allTabs = Tabs.stack;
      if(allTabs.length === 0) return;
      const idx = allTabs.findIndex(t => t.id === current);
      let next;
      if(e.key === 'ArrowRight') next = allTabs[(idx + 1) % allTabs.length];
      else next = allTabs[(idx - 1 + allTabs.length) % allTabs.length];
      if(next) { Tabs.activate(next.id); UI._switchViewOnly(next.id); }
      return;
     }

     

     if (e.key >= '1' && e.key <= '8' && !e.ctrlKey && !e.altKey) {
      const idx = parseInt(e.key) - 1;
      if(tabs[idx]) UI.switchTab(tabs[idx]);
      return;
     }

     

     if (e.key === 'F1') { e.preventDefault(); UI.switchTab('dashboard'); return; }
     if (e.key === 'F2') { e.preventDefault(); UI.switchTab('organizations'); return; }
     if (e.key === 'F3') { e.preventDefault(); UI.switchTab('contracts'); return; }
     if (e.key === 'F4') { e.preventDefault(); UI.switchTab('cases'); return; }
     if (e.key === 'F5') { e.preventDefault(); UI.switchTab('radar'); return; }

     

     if (e.key === 'a' || e.key === 'A') {
      UI.promptAdmin();
      return;
     }

     

     if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      const s = document.getElementById('search-input');
      if(s) { s.focus(); s.select(); }
      return;
     }
    });
    

    this.renderAll();
    Tabs.init('dashboard');
    // Mobil tespit
    const isMobile=window.innerWidth<=768||/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
    if(isMobile){
     document.body.classList.add('is-mobile');
     const cur=document.getElementById('custom-cursor');
     if(cur)cur.style.display='none';
     document.body.style.cursor='auto';
     try{UI.updateMobileTab('dashboard');}catch(e){}
     const setVH=()=>document.documentElement.style.setProperty('--vh',(window.innerHeight*.01)+'px');
     setVH();window.addEventListener('resize',setVH);
    }
    


    // Supabase polling (30sn'de bir sync kontrolü)
    // Eski arama panellerini temizle
    ['gsr-panel','global-search-panel','srp'].forEach(id => { const el=document.getElementById(id); if(el)el.remove(); });
    try { SupaSync.startPolling(30000); } catch(e) {}
    try { updatePlayerIndicator(); } catch(e) {}

    const savedTheme = localStorage.getItem(CFG.themeKey) || '';
    if(savedTheme) UI.applyTheme(savedTheme);
    

    
    document.getElementById('search-input').addEventListener('blur', () => {
     setTimeout(() => { const p=document.getElementById('srp'); if(p) p.style.display='none'; }, 200);
    });
    // Herhangi bir yere tıklayınca kapat (search input veya panel dışı)
    document.addEventListener('click', (e) => {
     const panel = document.getElementById('srp');
     const input = document.getElementById('search-input');
     if(!panel || panel.style.display === 'none') return;
     if(!panel.contains(e.target) && e.target !== input && !input?.contains(e.target)) {
      panel.style.display = 'none';
     }
    });
    document.getElementById('search-input').addEventListener('input', e => {
     const _sv = e.target.value;
     // "oyuncu:" prefix kontrolü: "eren:" → player filter
     const _pm = _sv.match(/^(eren|melih|tuna|nes|aley):/i);
     if(_pm) {
      activeFilters.player = _pm[1].toLowerCase();
      activeFilters.search = _sv.slice(_pm[0].length).toLowerCase().trim();
      // Sidebar player butonunu aktif yap
      document.querySelectorAll('.player-filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.player===activeFilters.player));
     } else {
      activeFilters.search = _sv.toLowerCase();
      try{UI.renderGlobalSearchResults(activeFilters.search);}catch(e){}
     }
     this.renderCharacters();
     this.renderVehicles();
     this.renderProperties();
     this.renderEquipments();
     this.renderContracts();
     this.renderCases();
     this.renderOrgs();
     this.renderSearchOverlay(activeFilters.search);
    });

    document.getElementById('radar-map-container').addEventListener('contextmenu', function(e) {
     e.preventDefault();
     if (e.target.closest('.map-pin')) return;
     const rect = this.getBoundingClientRect();
     const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(1);
     const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(1);
     
     const temp = document.createElement('input');
     document.body.appendChild(temp);
     temp.value = `X: ${x} | Y: ${y}`;
     temp.select();
     document.execCommand('copy');
     document.body.removeChild(temp);
     
     showSaveToast(`📍 Koordinat kopyalandı: X:${x} Y:${y}`);
    });
   },

   renderAll() {
    this.renderFilters();
    this.renderAnalytics();
    this.renderCharacters();
    this.renderOrgs();
    this.renderVehicles();
    this.renderProperties();
    this.renderEquipments();
    this.renderContracts();
    this.renderCases();
    this.renderLogs();
   },

   toggleLanguage() {
    currentLang = currentLang === 'en' ? 'tr' : 'en';
    Storage.saveLang(currentLang);
    this.updateLanguageUI();
    this.renderAll();
   },

   updateLanguageUI() {
    const dict = i18n[currentLang];
    const langBtn = document.getElementById('lang-btn');
    if(langBtn) langBtn.innerText = currentLang === 'en' ? 'TR' : 'EN';
    document.querySelectorAll('[data-i18n]').forEach(el => {
     const key = el.getAttribute('data-i18n');
     if (dict[key]) el.innerHTML = dict[key];
    });
    document.querySelectorAll('[data-i18n-ph]').forEach(el => {
     const key = el.getAttribute('data-i18n-ph');
     if (dict[key]) el.placeholder = dict[key];
    });
   },

   

   switchTab(tabId) {
    Tabs.open(tabId);
    this._switchViewOnly(tabId);
   },

   

   _switchViewOnly(tabId) {
    document.querySelectorAll('.view-section').forEach(el => el.classList.add('hidden'));
    const targetView = document.getElementById(`view-${tabId}`);
    if(targetView) targetView.classList.remove('hidden');

    

    document.querySelectorAll('.nav-link').forEach(el => {
     el.classList.remove('border-cyber-blue','text-white','bg-cyber-blue/10','border-cyber-red','bg-cyber-red/10','border-cyber-gold','bg-cyber-gold/10','border-cyber-green','bg-cyber-green/10','border-cyber-omega','bg-cyber-omega/10');
     el.classList.add('border-transparent','text-gray-400');
    });
    

    const navBtns = document.querySelectorAll('.nav-link');
    navBtns.forEach(btn => {
     const oc = btn.getAttribute('onclick') || '';
     if(oc.includes(`'${tabId}'`)) {
      if(tabId==='contracts') btn.classList.add('border-cyber-red','text-white','bg-cyber-red/10');
      else if(tabId==='cases') btn.classList.add('border-cyber-gold','text-white','bg-cyber-gold/10');
      else if(tabId==='radar') btn.classList.add('border-cyber-green','text-white','bg-cyber-green/10');
      else if(tabId==='equipments') btn.classList.add('border-cyber-omega','text-white','bg-cyber-omega/10');
      else btn.classList.add('border-cyber-blue','text-white','bg-cyber-blue/10');
      btn.classList.remove('border-transparent','text-gray-400');
     }
    });

    if(tabId === 'radar') this.renderRadar();
   },

   setTheme(name) { applyTheme(name); },

   renderSearchOverlay(q) {
    

    let overlay = document.getElementById('search-overlay');
    if(!q || q.length < 2) { if(overlay) overlay.style.display='none'; return; }
    if(!overlay) {
     overlay = document.createElement('div');
     overlay.id = 'search-overlay';
     overlay.className = 'absolute top-full left-0 right-0 bg-black/95 border border-cyber-blue/30 z-50 max-h-80 overflow-y-auto';
     document.querySelector('header .flex.items-center.gap-4')?.appendChild(overlay);
    }
    const results = [];
    DB.characters.filter(c=>!c.isClassified&&(c.name?.toLowerCase().includes(q)||c.alias?.toLowerCase().includes(q))).slice(0,4).forEach(c=>
     results.push({type:'char',icon:'fa-user',label:c.name,sub:c.alias||c.status,id:c.id,color:'var(--neon-blue)'}));
    DB.organizations.filter(o=>o.name?.toLowerCase().includes(q)).slice(0,3).forEach(o=>
     results.push({type:'org',icon:'fa-sitemap',label:o.name,sub:o.status||'',id:o.id,color:o.color}));
    DB.contracts.filter(c=>!c.archived&&(c.target?.toLowerCase().includes(q)||c.issuer?.toLowerCase().includes(q))).slice(0,3).forEach(c=>
     results.push({type:'con',icon:'fa-crosshairs',label:c.target,sub:c.status,id:c.id,color:'var(--neon-red)'}));
    DB.cases.filter(cf=>!cf.archived&&cf.title?.toLowerCase().includes(q)).slice(0,3).forEach(cf=>
     results.push({type:'case',icon:'fa-folder-open',label:cf.title,sub:cf.status,id:cf.id,color:'var(--neon-gold)'}));
    if(!results.length) { overlay.style.display='none'; return; }
    overlay.style.display='block';
    overlay.innerHTML = results.map(r=>`
     <div class="flex items-center gap-3 px-4 py-2 hover:bg-white/5 cursor-pointer font-mono text-xs border-b border-gray-900 click-sfx hover-sfx"
      onclick="document.getElementById('search-overlay').style.display='none';
       ${r.type==='char'?`UI.switchTab('dashboard');setTimeout(()=>UI.openModal('${r.id}'),200)`:
       r.type==='org'?`UI.switchTab('organizations');setTimeout(()=>UI.openOrgModal('${r.id}'),200)`:
       r.type==='con'?`UI.switchTab('contracts');setTimeout(()=>UI.openContractModal('${r.id}'),200)`:
       `UI.switchTab('cases');setTimeout(()=>UI.openCaseModal('${r.id}'),200)`}">
      <i class="fas ${r.icon} w-4" style="color:${r.color}"></i>
      <span class="text-white">${r.label}</span>
      <span class="text-gray-500 ml-1">${r.sub}</span>
      <span class="ml-auto text-gray-700 text-[9px] uppercase">${r.type}</span>
     </div>`).join('');
   },

   openFullProfile(id) {
    const c = DB.characters.find(x => x.id === id);
    if (!c) return;
    SFX.click();

    

    this.closeAllModals();
    const orgModal = document.getElementById('org-modal');
    if(orgModal) orgModal.style.display = 'none';
    const conModal = document.getElementById('contract-detail-modal');
    if(conModal) conModal.style.display = 'none';
    const caseModal = document.getElementById('case-detail-modal');
    if(caseModal) caseModal.style.display = 'none';

    const div = document.getElementById('profile-fullscreen');
    if (!div) return;

    

    const charOrgs = c.organizations || (c.organization ? [c.organization] : []);
    const orgBadges = charOrgs.map(oid => {
     const o = DB.organizations.find(x => x.id === oid);
     return o ? `<span class="font-mono text-[10px] border px-2 py-0.5" style="color:${o.color};border-color:${o.color}50">${o.name}</span>` : '';
    }).join('');

    

    const rels = (c.relationships || []).map(r => {
     const t = DB.characters.find(x => x.id === r.targetId);
     if (!t) return '';
     const tImg = t.image || `https://ui-avatars.com/api/?name=${encodeURIComponent(t.name)}&background=000&color=fff`;
     return `<div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800 cursor-pointer hover:border-cyber-blue transition-colors" onclick="UI.openFullProfile('${t.id}')">
      <img src="${tImg}" class="w-10 h-10 rounded-full object-cover border border-gray-700">
      <div><div class="font-mono text-xs text-white">${t.name}</div><div class="font-mono text-[9px] text-gray-500 uppercase">${r.type}</div></div>
     </div>`;
    }).join('');

    

    const cases = DB.cases.filter(cf => (cf.suspects || cf.tags || []).includes(c.id))
     .map(cf => `<span class="font-mono text-[10px] border border-cyber-gold/30 text-cyber-gold px-2 py-0.5 cursor-pointer hover:border-cyber-gold inline-block mb-1" onclick="UI.openFullProfile('');UI.openCaseModal('${cf.id}')">${cf.title}</span>`).join('');

    

    const contracts = DB.contracts.filter(cn => cn.assigned === c.id || cn.target === c.name)
     .map(cn => `<span class="font-mono text-[10px] border border-cyber-red/30 text-cyber-red px-2 py-0.5 inline-block mb-1">${cn.target} [${cn.status}]</span>`).join('');

    

    const rep = c.reputation || { global: 0, level: 'Unknown', orgs: {}, notes: '' };
    const repColors = { Unknown:'#6b7280', Street:'#9ca3af', Known:'#60a5fa', Notorious:'#f59e0b', Legendary:'#f97316', Mythic:'#a855f7' };
    const repIcons  = { Unknown:'fa-question-circle', Street:'fa-circle', Known:'fa-eye', Notorious:'fa-skull', Legendary:'fa-fire', Mythic:'fa-crown' };
    const repCol  = repColors[rep.level] || '#6b7280';
    const repIcon = repIcons[rep.level]  || 'fa-question-circle';
    const gv  = rep.global || 0;
    const gPct = ((gv + 100) / 200) * 100;
    const gCol = gv >= 75 ? '#a855f7' : gv >= 40 ? '#f97316' : gv >= 10 ? '#60a5fa' : gv <= -40 ? '#ff2a2a' : gv <= -10 ? '#facc15' : '#6b7280';

    const orgRepRows = Object.entries(rep.orgs || {}).map(([oid, score]) => {
     const o = DB.organizations.find(x => x.id === oid);
     if (!o) return '';
     const sPct = ((score + 100) / 200) * 100;
     const sCol = score >= 50 ? '#22c55e' : score >= 10 ? '#60a5fa' : score <= -50 ? '#ff2a2a' : score <= -10 ? '#facc15' : '#6b7280';
     return `<div class="rep-org-row mb-2">
      <span class="w-28 truncate" style="color:${o.color}">${o.name}</span>
      <div class="rep-bar-track"><div class="rep-bar-fill" style="width:${sPct}%;background:${sCol}"></div></div>
      <span class="rep-score-badge" style="color:${sCol}">${score > 0 ? '+' : ''}${score}</span>
     </div>`;
    }).join('');

    

    div.innerHTML = `
    <div style="min-height:100vh;background:#050510">
     
     <div class="sticky top-0 z-10 flex justify-between items-center px-6 py-3 border-b border-gray-800" style="background:rgba(5,5,16,0.95);backdrop-filter:blur(10px)">
      <button onclick="document.getElementById('profile-fullscreen').style.display='none';document.getElementById('theme-song-player').innerHTML=''" style="cursor:pointer" class="cyber-button px-4 py-2 text-xs click-sfx hover-sfx"><i class="fas fa-arrow-left mr-2"></i>GERİ</button>
      <h1 class="font-display font-black text-xl text-white">${c.isClassified ? '[ CLASSIFIED ]' : c.name}</h1>
      <div class="flex gap-2">
       <button onclick="UI.promptAdmin();setTimeout(()=>{Admin.switchTab('chars');Admin.editChar('${c.id}');document.getElementById('profile-fullscreen').style.display='none';},300)" style="cursor:pointer" class="cyber-button px-4 py-2 text-xs click-sfx hover-sfx"><i class="fas fa-edit mr-2"></i>DÜZENLE</button>
       <button onclick="UI.printProfile('${c.id}')" style="cursor:pointer" class="cyber-button px-4 py-2 text-xs click-sfx hover-sfx" style="border-color:var(--neon-purple);color:var(--neon-purple)"><i class="fas fa-print mr-2"></i>PDF</button>
      </div>
     </div>

     
     <div class="max-w-5xl mx-auto p-6 grid grid-cols-1 md:grid-cols-3 gap-6">

      
      <div>
       <div class="aspect-square overflow-hidden border-2 mb-4" style="border-color:var(--neon-blue)">
        ${c.isClassified
         ? `<div class="w-full h-full flex items-center justify-center bg-black text-cyber-red font-display text-2xl font-black">CLASSIFIED</div>`
         : `<img src="${c.image || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=000&color=fff&size=256`}" class="w-full h-full object-cover">`
        }
       </div>
       <div class="glass-panel p-4 border border-gray-800 space-y-2 font-mono text-xs mb-4">
        <div class="flex justify-between"><span class="text-gray-500">DURUM</span><span class="threat-${c.threatLevel}">${c.status}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">TEHDİT</span><span class="threat-${c.threatLevel} font-bold">${c.threatLevel}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">ISIL</span><span class="heat-${(c.heatLevel||'Clean').replace(' ','_')}">${c.heatLevel || 'Clean'}</span></div>
        ${c.statusNote ? `<div class="flex justify-between border-t border-gray-800 pt-2 mt-2"><span class="text-gray-500">DURUM NOTU</span><span class="text-cyber-blue text-right max-w-[60%]">${c.statusNote}</span></div>` : ''}
       </div>
       
       <div class="glass-panel p-4 border border-gray-800">
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-3">İTİBAR</div>
        <div class="text-center mb-3">
         <div class="font-display font-black text-xl" style="color:${repCol}"><i class="fas ${repIcon} mr-1"></i>${rep.level}</div>
        </div>
        <div class="flex justify-between font-mono text-[10px] text-gray-500 mb-1"><span>GLOBAL</span><span style="color:${gCol}">${gv > 0 ? '+' : ''}${gv}</span></div>
        <div class="rep-bar-track h-2 mb-3"><div class="rep-bar-fill" style="width:${gPct}%;background:${gCol}"></div></div>
        ${orgRepRows}
        ${rep.notes ? `<p class="font-mono text-[10px] text-gray-400 italic border-l-2 border-gray-700 pl-2 mt-2">${rep.notes}</p>` : ''}
       </div>
      </div>

      
      <div class="md:col-span-2 space-y-5">
       
       <div>
        <h2 class="font-display font-black text-4xl text-white mb-1">${c.isClassified ? '[ REDACTED ]' : c.name}</h2>
        ${c.alias ? `<p class="font-mono text-cyber-blue text-sm mb-2">"${c.alias}"</p>` : ''}
        <div class="flex flex-wrap gap-2 mb-3">${orgBadges}</div>
       </div>

       
       ${c.story ? `<div class="glass-panel p-4 border border-gray-800">
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">BACKGROUND</div>
        <p class="font-mono text-xs text-gray-300 leading-relaxed whitespace-pre-line">${c.story}</p>
       </div>` : ''}
       <div id="theme-song-player"></div>

       
       ${rels ? `<div>
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">İLİŞKİLER</div>
        <div class="space-y-2">${rels}</div>
       </div>` : ''}

       
       ${cases ? `<div>
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">DAVALAR</div>
        <div class="flex flex-wrap gap-2">${cases}</div>
       </div>` : ''}

       
       ${(c.bankAccounts||[]).length > 0 ? `<div>
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">BANKA HESAPLARI</div>
        <div class="space-y-2">
        ${(c.bankAccounts||[]).map(acc=>`
         <div class="flex items-center gap-3 p-3 bg-black/40 border border-cyber-blue/20 font-mono text-xs">
          <i class="fas fa-landmark text-cyber-blue"></i>
          <div class="flex-1"><span class="text-white font-bold">${acc.bank||'—'}</span><span class="text-gray-500 ml-2">${acc.account||''}</span>${acc.note?`<div class="text-gray-400 text-[10px] italic mt-0.5">${acc.note}</div>`:''}</div>
          ${acc.balance?`<span class="text-cyber-green border border-cyber-green/30 px-2 py-0.5">${acc.balance}</span>`:''}
         </div>`).join('')}
        </div>
       </div>` : ''}

       
       ${contracts ? `<div>
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">KONTRATLAR</div>
        <div class="flex flex-wrap gap-2">${contracts}</div>
       </div>` : ''}
      </div>
     </div>
    </div>`;

    div.style.display = 'block';
    div.scrollTop = 0;
    // Theme Song - profile-fullscreen için
    const songEl = document.getElementById('theme-song-player');
    if(songEl) {
      if(c.themeSong) UI._renderThemeSong(songEl, c.themeSong);
      else songEl.innerHTML = '';
    }
   },

   _renderThemeSong(el, song) {
      let platform = '';
      let embedUrl = '';
      let thumbUrl = '';

      if(song.includes('spotify.com')) {
        platform = 'spotify';
        const spId = song.match(/track\/([A-Za-z0-9]+)/)?.[1];
        if(spId) {
          embedUrl = 'https://open.spotify.com/embed/track/' + spId + '?utm_source=generator&theme=0';
          thumbUrl = '';
        }
      } else if(song.includes('youtube.com') || song.includes('youtu.be')) {
        platform = 'youtube';
        const ytId = song.match(/(?:v=|youtu\.be\/)([A-Za-z0-9_-]{11})/)?.[1];
        if(ytId) {
          embedUrl = 'https://www.youtube.com/embed/' + ytId + '?autoplay=1&rel=0';
          thumbUrl = 'https://img.youtube.com/vi/' + ytId + '/mqdefault.jpg';
        }
      }

      if(embedUrl) {
        el.innerHTML = '';
        var icon = platform === 'spotify' ? '#1DB954' : '#FF0000';
        var iconClass = platform === 'spotify' ? 'fab fa-spotify' : 'fab fa-youtube';
        var platformLabel = platform === 'spotify' ? 'Spotify' : 'YouTube';
        var bg = (platform === 'youtube' && thumbUrl)
          ? 'background-image:url(' + thumbUrl + ');background-size:cover;background-position:center;'
          : 'background:' + (platform === 'spotify' ? '#191414' : '#0f0f0f') + ';';
        // data-url ile onclick karmaşasını önle
        var wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-top:12px;border-radius:6px;overflow:hidden;border:1px solid rgba(255,255,255,0.1)';
        var btn = document.createElement('div');
        btn.style.cssText = bg + 'position:relative;height:72px;display:flex;align-items:center;cursor:pointer;padding:0 16px;gap:12px';
        btn.dataset.embedUrl = embedUrl;
        btn.addEventListener('click', function() {
          var iframe = document.createElement('iframe');
          iframe.src = this.dataset.embedUrl;
          iframe.width = '100%';
          iframe.height = '80';
          iframe.frameBorder = '0';
          iframe.allow = 'autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture';
          iframe.allowFullscreen = true;
          iframe.style.borderRadius = '6px';
          this.parentElement.replaceWith(iframe);
        });
        btn.innerHTML =
          '<div style="position:absolute;inset:0;background:rgba(0,0,0,0.5)"></div>' +
          '<div style="width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,0.1);display:flex;align-items:center;justify-content:center;border:2px solid ' + icon + ';flex-shrink:0;position:relative">' +
            '<i class="' + iconClass + '" style="color:' + icon + ';font-size:18px"></i>' +
          '</div>' +
          '<div style="position:relative">' +
            '<div style="color:rgba(255,255,255,0.4);font-size:9px;letter-spacing:.1em;text-transform:uppercase;font-family:monospace">' + platformLabel + ' · THEME SONG</div>' +
            '<div style="color:#fff;font-size:12px;margin-top:3px;font-family:monospace">&#9654; Çalmak için tıkla</div>' +
          '</div>';
        wrapper.appendChild(btn);
        el.innerHTML = '';
        el.appendChild(wrapper);
      } else {
        el.innerHTML = '';
      }
   },  // _renderThemeSong sonu

   printProfile(id) {
    const c = DB.characters.find(x=>x.id===id); if(!c||!window.html2pdf) return;
    const div = document.getElementById('profile-fullscreen');
    if(!div) return;
    const opt = { margin:10, filename:`${c.name||'profile'}.pdf`, image:{type:'jpeg',quality:0.9}, html2canvas:{scale:2,useCORS:true,backgroundColor:'#050505'}, jsPDF:{unit:'mm',format:'a4',orientation:'portrait'} };
    html2pdf().set(opt).from(div).save();
   },


   renderGlobalSearchResults(q) {
    // Her zaman body'deki TEK paneli kullan
    let panel = document.getElementById('srp'); // search-results-panel
    if(!q || q.length < 2) {
     if(panel) panel.style.display = 'none';
     return;
    }
    // Panel yoksa bir kez oluştur
    if(!panel) {
     panel = document.createElement('div');
     panel.id = 'srp';
     panel.style.cssText = 'position:fixed;left:0;right:0;z-index:99990;max-height:320px;overflow-y:auto;background:#06060e;border-top:2px solid var(--neon-blue);border-bottom:1px solid rgba(0,162,255,0.2);box-shadow:0 8px 32px rgba(0,0,0,0.98);font-family:\'Share Tech Mono\',monospace;font-size:12px;display:none';
     document.body.appendChild(panel);
    }
    // Pozisyonu header altına güncelle
    const hdr = document.querySelector('header');
    panel.style.top = (hdr ? hdr.getBoundingClientRect().bottom : 64) + 'px';

    const res = [];
    DB.characters.filter(c=>!c.isClassified&&(c.name.toLowerCase().includes(q)||(c.alias||'').toLowerCase().includes(q))).slice(0,3).forEach(c=>
     res.push({type:'KAR',icon:'fa-user-secret',label:c.name+(c.alias?' / '+c.alias:''),color:'var(--neon-blue)',action:"UI.openModal('"+c.id+"')"}));
    DB.organizations.filter(o=>o.name.toLowerCase().includes(q)).slice(0,2).forEach(o=>
     res.push({type:'ORG',icon:'fa-sitemap',label:o.name,color:o.color,action:"UI.switchTab('organizations')"}));
    DB.contracts.filter(c=>!c.archived&&(c.target||'').toLowerCase().includes(q)).slice(0,2).forEach(c=>
     res.push({type:'KONTRAT',icon:'fa-crosshairs',label:c.target,color:'var(--neon-red)',action:"UI.openContractModal('"+c.id+"')"}));
    DB.cases.filter(cf=>!cf.archived&&(cf.title||'').toLowerCase().includes(q)).slice(0,2).forEach(cf=>
     res.push({type:'DAVA',icon:'fa-folder-open',label:cf.title,color:'var(--neon-gold)',action:"UI.openCaseModal('"+cf.id+"')"}));
    (DB.events||[]).filter(ev=>(ev.title||'').toLowerCase().includes(q)).slice(0,2).forEach(ev=>
     res.push({type:'OLAY',icon:'fa-bolt',label:ev.title,color:ev.color||'#a855f7',action:"UI.switchTab('radar')"}));

    if(!res.length) { panel.style.display='none'; return; }

    panel.innerHTML = res.map(r=>'<div onclick="'+r.action+';document.getElementById(\'srp\').style.display=\'none\';document.getElementById(\'search-input\').blur()" style="display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05);cursor:pointer;background:#06060e" onmouseover="this.style.background=\'rgba(0,162,255,0.08)\'" onmouseout="this.style.background=\'#06060e\'"><i class="fas '+r.icon+'" style="color:'+r.color+';width:16px;text-align:center;flex-shrink:0"></i><span style="color:#4b5563;font-size:9px;text-transform:uppercase;width:52px;flex-shrink:0">'+r.type+'</span><span style="color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+r.label+'</span></div>').join('');
    panel.style.display = 'block';
   },

   applyTheme(name) {
    const themes = ['red','green','purple','gold','white'];
    themes.forEach(t => document.body.classList.remove('theme-'+t));
    if(name) document.body.classList.add('theme-'+name);
    

    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    const activeId = 'th-' + (name||'blue');
    const activeBtn = document.getElementById(activeId);
    if(activeBtn) activeBtn.classList.add('active');
    

    localStorage.setItem(CFG.themeKey, name);
    

    this.renderFilters();
   },

   filterPlayer(pid) {
    activeFilters.player = pid || 'all';
    const si = document.getElementById('search-input');
    if(si && (window.NYC_PLAYERS||[]).some(p=>si.value.toLowerCase().startsWith(p.id+':'))) {
     si.value = ''; activeFilters.search = '';
    }
    document.querySelectorAll('.player-filter-btn').forEach(b=>{
     b.classList.toggle('active', b.dataset.player===activeFilters.player);
    });
    // Aktif gösterge
    const pInd = document.getElementById('player-filter-indicator');
    if(pInd) {
     if(activeFilters.player !== 'all') {
      const pl=(window.NYC_PLAYERS||[]).find(p=>p.id===activeFilters.player);
      pInd.textContent = pl?pl.name.toUpperCase():'NPC';
      pInd.style.color = pl?pl.color:'#6b7280';
      pInd.style.display='inline';
     } else { pInd.style.display='none'; }
    }
    this.renderCharacters();
   },
   toggleMobileMenu() {
    const overlay=document.getElementById('mobile-sidebar-overlay');
    const panel=document.getElementById('mobile-sidebar-panel');
    if(!overlay||!panel) return;
    if(!panel.innerHTML.trim()){const aside=document.querySelector('aside');if(aside)panel.innerHTML=aside.innerHTML;}
    const isOpen=overlay.classList.toggle('open');
    panel.classList.toggle('open',isOpen);
    document.body.style.overflow=isOpen?'hidden':'';
   },
   closeMobileMenu() {
    document.getElementById('mobile-sidebar-overlay')?.classList.remove('open');
    document.getElementById('mobile-sidebar-panel')?.classList.remove('open');
    document.body.style.overflow='';
   },
   updateMobileTab(tab) {
    document.querySelectorAll('#mobile-tabbar button').forEach(b=>{
     b.classList.toggle('active',b.dataset.mtab===tab);
    });
   },
   toggleCursorAnim() {
    const isOff = document.body.classList.toggle('cursor-no-anim');
    localStorage.setItem('nyc_cursor_anim', isOff ? '0' : '1');
    this.updateCursorAnimSwitch();
   },
   updateCursorAnimSwitch() {
    const isOff = document.body.classList.contains('cursor-no-anim');
    const btn  = document.getElementById('cursor-anim-toggle');
    const knob = document.getElementById('cursor-anim-knob');
    if(btn)  { btn.style.background=isOff?'rgba(255,255,255,0.05)':'rgba(0,162,255,0.3)'; btn.style.borderColor=isOff?'#4b5563':'var(--neon-blue)'; }
    if(knob) { knob.style.background=isOff?'#4b5563':'var(--neon-blue)'; knob.style.transform=isOff?'translateX(1px)':'translateX(20px)'; }
   },

   renderFilters() {
    // Player filter butonlarını renderla
    const _pf = document.getElementById('player-filters');
    if(_pf && window.NYC_PLAYERS) {
     const _npcLabel = _pf.querySelector('label:last-child');
     _pf.querySelectorAll('.player-filter-btn-wrap').forEach(el=>el.remove());
     window.NYC_PLAYERS.forEach(p => {
      const wrap = document.createElement('label');
      wrap.className='player-filter-btn-wrap flex items-center gap-3 cursor-pointer hover:text-white transition-colors py-1 group hover-sfx';
      wrap.innerHTML=`<input type="radio" name="player" ${activeFilters.player===p.id?'checked':''} onclick="UI.filterPlayer('${p.id}')" class="cyber-radio click-sfx player-filter-btn" data-player="${p.id}"><span class="tracking-widest uppercase text-[10px] mt-0.5" style="color:${p.color}">${p.name}</span>`;
      _pf.insertBefore(wrap, _npcLabel);
     });
    }
    const dict = i18n[currentLang];
    const cont = document.getElementById('org-filters');
    if(!cont) return;
    const isAllOrg = activeFilters.org.has('all');
    let html = `<label class="flex items-center gap-3 cursor-pointer text-gray-400 hover:text-white transition-colors py-1 group hover-sfx"><input type="checkbox" id="of-all" onchange="UI.filterOrgCheck('all',this)" ${isAllOrg?'checked':''} class="cyber-checkbox click-sfx"><span class="tracking-widest uppercase text-[10px] mt-0.5">${dict.all_records}</span></label>`;
    DB.organizations.forEach(o => {
     const chk = !isAllOrg && activeFilters.org.has(o.id);
     html += `<label class="flex items-center gap-3 cursor-pointer hover:text-white transition-colors py-1 group hover-sfx" style="color:${o.color}"><input type="checkbox" onchange="UI.filterOrgCheck('${o.id}',this)" ${chk?'checked':''} class="cyber-checkbox click-sfx" style="--neon-red:${o.color}"><span class="tracking-widest uppercase text-[10px] mt-0.5 truncate opacity-80 group-hover:opacity-100">${o.name}</span></label>`;
    });
    cont.innerHTML = html;
   },

   filterOrgCheck(val, cb) {
    if(val==='all'){activeFilters.org=new Set(['all']);document.querySelectorAll('#org-filters input[type=checkbox]').forEach(el=>el.checked=(el.id==='of-all'));}
    else{if(cb.checked){activeFilters.org.delete('all');activeFilters.org.add(val);const a=document.getElementById('of-all');if(a)a.checked=false;}else{activeFilters.org.delete(val);if(activeFilters.org.size===0){activeFilters.org.add('all');const a=document.getElementById('of-all');if(a)a.checked=true;}}}
    this.renderCharacters();
   },
   filterThreatCheck(val, cb) {
    if(val==='all'){activeFilters.threat=new Set(['all']);document.querySelectorAll('#threat-filters input[type=checkbox]').forEach(el=>el.checked=(el.id==='tf-all'));}
    else{if(cb.checked){activeFilters.threat.delete('all');activeFilters.threat.add(val);const a=document.getElementById('tf-all');if(a)a.checked=false;}else{activeFilters.threat.delete(val);if(activeFilters.threat.size===0){activeFilters.threat.add('all');const a=document.getElementById('tf-all');if(a)a.checked=true;}}}
    this.renderCharacters();
   },
   filterHeatCheck(val, cb) {
    if(val==='all'){activeFilters.heat=new Set(['all']);document.querySelectorAll('#heat-filters input[type=checkbox]').forEach(el=>el.checked=(el.id==='hf-all'));}
    else{if(cb.checked){activeFilters.heat.delete('all');activeFilters.heat.add(val);const a=document.getElementById('hf-all');if(a)a.checked=false;}else{activeFilters.heat.delete(val);if(activeFilters.heat.size===0){activeFilters.heat.add('all');const a=document.getElementById('hf-all');if(a)a.checked=true;}}}
    this.renderCharacters(); this.renderVehicles();
   },
   

   filterOrg(val){activeFilters.org=val==='all'?new Set(['all']):new Set([val]);this.renderCharacters();},
   filterThreat(val){activeFilters.threat=val==='all'?new Set(['all']):new Set([val]);this.renderCharacters();},
   filterHeat(val){activeFilters.heat=val==='all'?new Set(['all']):new Set([val]);this.renderCharacters();this.renderVehicles();},

   getOrg(id) { return DB.organizations.find(o => o.id === id) || { name: 'Unaffiliated', color: '#6b7280' }; },

   renderAnalytics() {
    const sT = document.getElementById('stat-total'); if(sT) sT.innerText = DB.characters.length;
    const sA = document.getElementById('stat-active'); if(sA) sA.innerText = DB.characters.filter(c => c.status !== 'Deceased').length;
    const sD = document.getElementById('stat-dead'); if(sD) sD.innerText = DB.characters.filter(c => c.status === 'Deceased').length;
    const sO = document.getElementById('stat-omega'); if(sO) sO.innerText = DB.characters.filter(c => c.threatLevel === 'Omega').length;
    const sE = document.getElementById('stat-extreme'); if(sE) sE.innerText = DB.characters.filter(c => c.threatLevel === 'Extreme').length;
    const sW = document.getElementById('stat-wanted'); if(sW) sW.innerText = DB.characters.filter(c => c.heatLevel === 'Most Wanted').length;
    const sOrgs = document.getElementById('stat-orgs');
    if(sOrgs) sOrgs.innerText = DB.organizations.length;
    const sCon = document.getElementById('stat-contracts');
    if(sCon) sCon.innerText = DB.contracts.filter(c => !c.archived && ['Open','Assigned','In Progress'].includes(c.status)).length;
    const sCases = document.getElementById('stat-cases');
    if(sCases) sCases.innerText = DB.cases.filter(c => !c.archived && !['Closed','Archived'].includes(c.status)).length;
   },

   renderCharacters() {
    const dict = i18n[currentLang];
    const grid = document.getElementById('character-grid');
    if(!grid) return;
    let count = 0;
    let html = '';
    let rezHtml = '';
    let rezCount = 0;
    
    getSortedChars().forEach(c => {
     // Arşivlenenleri ana grid'e gösterme
     if (c.isArchived) return;
     
     const isRez = c.profileType === 'profile';
     const charOrgs = c.organizations || (c.organization ? [c.organization] : []);
     if (!activeFilters.org.has('all') && !charOrgs.some(oid => activeFilters.org.has(oid))) return;
     if (!activeFilters.threat.has('all') && !activeFilters.threat.has(c.threatLevel)) return;
     if (!activeFilters.heat.has('all') && !activeFilters.heat.has(c.heatLevel)) return;
     if (activeFilters.player === 'npc' && c.playerId) return;
     if (activeFilters.player !== 'all' && activeFilters.player !== 'npc' && (c.playerId || '') !== activeFilters.player) return;
     
     const sName = c.name ? c.name.toLowerCase() : '';
     const sAlias = c.alias ? c.alias.toLowerCase() : '';
     

     const charOrgNames = (c.organizations||(c.organization?[c.organization]:[])).map(oid=>{const o=DB.organizations.find(x=>x.id===oid);return o?o.name.toLowerCase():'';});
     const sStatus = (c.statusNote||'').toLowerCase();
     const sStory  = (c.story||'').toLowerCase();
     if (activeFilters.search &&
      !sName.includes(activeFilters.search) &&
      !sAlias.includes(activeFilters.search) &&
      !charOrgNames.some(n=>n.includes(activeFilters.search)) &&
      !sStatus.includes(activeFilters.search) &&
      !sStory.includes(activeFilters.search)) return;

     const charOrgsArr = c.organizations || (c.organization ? [c.organization] : []);
     if (isRez) { rezCount++; } else { count++; }
     const org = this.getOrg(charOrgsArr[0] || c.organization); 

     const isDeceased   = c.status === 'Deceased';
     const isClassified = c.isClassified;
     const isLocked     = c.isLocked && !isClassified;
     
     const displayName  = isClassified ? '[ REDACTED ]' : c.name;
     const displayAlias = isClassified ? '[ UNKNOWN ]'  : (c.alias ? `"${c.alias}"` : dict.no_alias);
     const img          = isClassified ? '' : (c.image || `https://ui-avatars.com/api/?name=${c.name}&background=000&color=fff`);
     
     const statusClass  = isDeceased ? 'status-deceased' : 'status-active';
     let imgFilter      = isDeceased ? 'grayscale opacity-30' : (CFG.colorPhotos ? 'opacity-85 hover:opacity-100' : 'grayscale hover:grayscale-0');
     if (isClassified) imgFilter = 'backdrop-blur-xl bg-gray-900';
     
     const translatedStatus = dict[c.status.toLowerCase()] || c.status;
     const threatClass = c.threatLevel === 'Omega' ? 'threat-Omega' : `threat-${c.threatLevel}`;
     const translatedThreat = dict[c.threatLevel.toLowerCase()] || c.threatLevel;
     
     const heatClass = `heat-${c.heatLevel.replace(' ', '_')}`;
     const translatedHeat = dict[c.heatLevel.toLowerCase().replace(' ', '_')] || c.heatLevel;

     const cardHtml = `
      <div class="cyber-card glass-panel flex flex-col cursor-pointer border-t-2 overflow-hidden hover-sfx click-sfx" style="border-top-color: ${isClassified ? '#1f2937' : org.color}" onclick="UI.openModal('${c.id}')">
       <div class="h-60 overflow-hidden relative bg-black">
        ${isClassified
          ? `<div class="w-full h-full flex items-center justify-center ${imgFilter}"><i class="fas fa-user-secret text-6xl text-gray-700"></i></div>`
          : `<img src="${img}" class="w-full h-full object-cover object-top filter ${imgFilter} transition-all duration-500">`}
        ${isLocked ? `<div class="absolute inset-0 flex flex-col items-center justify-center" style="background:rgba(0,0,0,0.45);backdrop-filter:blur(2px)"><i class="fas fa-lock text-4xl mb-2" style="color:rgba(255,255,255,0.7)"></i><span class="font-mono text-[10px] tracking-widest" style="color:rgba(255,255,255,0.5)">LOCKED</span></div>` : ''}
        <div class="absolute bottom-0 left-0 w-full p-2 bg-gradient-to-t from-black to-transparent flex justify-between items-end">
         <div class="flex flex-wrap gap-1">
          ${(()=>{const _pl=(window.NYC_PLAYERS||[]).find(p=>p.id===c.playerId);return _pl?`<span class="inline-block font-mono text-[9px] px-1.5 py-0.5 border" style="color:${_pl.color};border-color:${_pl.color}50">${_pl.name}</span>`:''})()}
          ${isClassified
           ? `<div class="inline-block px-2 py-0.5 bg-black/80 font-mono text-[9px] border border-gray-700 uppercase tracking-widest text-gray-500">CLASSIFIED</div>`
           : charOrgsArr.slice(0,2).map(oid => {
            const o2 = this.getOrg(oid);
            return `<div class="inline-block px-2 py-0.5 bg-black/80 font-mono text-[9px] border uppercase tracking-widest truncate max-w-[90px]" style="border-color:${o2.color}50;color:${o2.color}">${o2.name}</div>`;
           }).join('') + (charOrgsArr.length > 2 ? `<div class="inline-block px-1 py-0.5 bg-black/80 font-mono text-[9px] border border-gray-700 text-gray-500">+${charOrgsArr.length-2}</div>` : '')
          }
         </div>
         ${c.heatLevel === 'Most Wanted' ? '<i class="fas fa-exclamation-triangle text-cyber-red animate-pulse text-lg drop-shadow-[0_0_8px_rgba(255,42,42,0.8)]"></i>' : ''}
        </div>
        ${isDeceased && !isClassified ? '<div class="absolute inset-0 flex items-center justify-center pointer-events-none"><i class="fas fa-skull text-6xl text-red-500/50"></i></div>' : ''}
       </div>
       <div class="p-4 flex-1 flex flex-col justify-between">
        <div class="mb-3">
         <h3 class="font-display font-bold text-lg text-white truncate ${statusClass}">${displayName}</h3>
         <p class="font-mono text-[10px] text-gray-500 truncate mt-1 tracking-widest">${displayAlias}</p>
        </div>
        <div class="flex justify-between items-center font-mono text-[10px] border-t border-gray-800 pt-2">
         <span class="${threatClass} uppercase font-bold tracking-widest"><i class="fas fa-exclamation-triangle mr-1"></i>${translatedThreat}</span>
         <span class="${heatClass} uppercase font-bold tracking-widest text-right"><i class="fas fa-star mr-1"></i>${translatedHeat}</span>
        </div>
        ${(() => {
         const rep = c.reputation;
         if(!rep || rep.level === 'Unknown') return '';
         const rColors = {'Street':'#9ca3af','Known':'#60a5fa','Notorious':'#f59e0b','Legendary':'#f97316','Mythic':'#a855f7'};
         const col = rColors[rep.level] || '#6b7280';
         return `<div class="flex justify-between items-center font-mono text-[9px] border-t border-gray-800 pt-1.5 mt-1">
          <span style="color:${col}"><i class="fas fa-star-half-alt mr-1"></i>${rep.level}</span>
          <span style="color:${col}" class="font-bold">${rep.global > 0 ? '+' : ''}${rep.global}</span>
         </div>`;
        })()}
       </div>
      </div>`;
     if(isRez) rezHtml += cardHtml; else html += cardHtml;
    });
    grid.innerHTML = html;
    const counter = document.getElementById('counter-chars');
    if(counter) counter.innerText = `${count} ${dict.matches}`;
    // Rez karakterler grid
    const rezGrid = document.getElementById('rez-character-grid');
    if(rezGrid) rezGrid.innerHTML = rezHtml;
    const rezCounter = document.getElementById('counter-rez-chars');
    if(rezCounter) rezCounter.innerText = `${rezCount} Kayıt`;
   },

   renderOrgs() {
    const grid = document.getElementById('org-grid');
    if(!grid) return;
    const osq = activeFilters.search||'';
    const visOrgs = DB.organizations.filter(o=>!osq||o.name.toLowerCase().includes(osq)||o.description?.toLowerCase().includes(osq)||(o.tags||[]).some(t=>t.toLowerCase().includes(osq)));
    grid.innerHTML = visOrgs.map(o => {
     const memberCount = DB.characters.filter(c=>(c.organizations||(c.organization?[c.organization]:[])).includes(o.id)).length;
     const topMembers = DB.characters.filter(c=>(c.organizations||[]).includes(o.id)).slice(0,3).map(c=>{
       const role = (o.members||[]).find(m=>m.charId===c.id)?.role||'';
       return `<div class="flex items-center gap-1.5 font-mono text-[9px]"><span class="text-gray-400 truncate">${c.name}</span>${role?`<span style="color:${o.color};opacity:.8">${role}</span>`:''}</div>`;
     }).join('');
     const status = o.status||'Active';
     const sColor = {Active:'text-cyber-green',Inactive:'text-yellow-400',Defunct:'text-gray-500',Shadow:'text-purple-400'}[status]||'text-gray-400';
     const tags = (o.tags||[]).map(t=>`<span class="bg-black/60 border px-2 py-0.5 text-[9px] font-mono uppercase tracking-widest" style="border-color:${o.color}40;color:${o.color}">${t}</span>`).join('');
     const members = DB.characters.filter(c=>(c.organizations||(c.organization?[c.organization]:[])).includes(o.id)&&!c.isClassified).slice(0,5);
     const avatars = members.map(c=>`<img src="${c.image||`https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=000&color=fff`}" title="${c.name}" class="w-8 h-8 rounded-full object-cover border-2 -ml-2 first:ml-0 cursor-pointer hover:scale-110 transition-transform hover-sfx click-sfx" style="border-color:${o.color}" onclick="event.stopPropagation();UI.openModal('${c.id}')">`).join('');
     const bannerStyle = o.banner?`background-image:url('${o.banner}');background-size:cover;background-position:center;`:`background:linear-gradient(135deg,${o.color}18,transparent);`;
     const logoHtml = o.image?`<img src="${o.image}" class="absolute bottom-3 right-3 w-12 h-12 object-contain opacity-80">`:'';
     const extLinks = (()=>{const arr=Array.isArray(o.links)?o.links:(typeof o.links==='string'&&o.links?o.links.split(',').map(u=>({label:'LINK',url:u.trim()})):[]);return arr.filter(l=>l.url).map(l=>`<a href="${l.url}" target="_blank" onclick="event.stopPropagation()" class="cyber-button px-2 py-1 text-[9px] hover-sfx" style="color:${o.color};border-color:${o.color}">${l.label||'LINK'}</a>`).join('');})();
     return `<div class="glass-panel flex flex-col overflow-hidden hover-sfx cursor-pointer transition-all hover:shadow-lg" style="border-top:3px solid ${o.color}" onclick="UI.openOrgModal('${o.id}')">
      <div class="h-24 relative flex-shrink-0" style="${bannerStyle}">
       <div class="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent"></div>
       ${logoHtml}
       <div class="absolute top-3 left-3 flex gap-1 flex-wrap">${tags}</div>
      </div>
      <div class="p-5 flex flex-col flex-1">
       <div class="flex justify-between items-start mb-2">
        <h3 class="font-display text-xl font-black leading-tight" style="color:${o.color}">${o.name}</h3>
        <div class="flex flex-col items-end gap-1 ml-2 flex-shrink-0">
          <span class="${sColor} font-mono text-[10px] uppercase tracking-widest">${status}</span>
          <span class="threat-${o.threatLevel||'Low'} font-mono text-[10px] uppercase tracking-widest">${o.threatLevel||'Low'}</span>
          <span class="heat-${(o.heatLevel||'Clean').replace(' ','_')} font-mono text-[9px] uppercase tracking-widest">${o.heatLevel||'Clean'}</span>
        </div>
       </div>
       <p class="font-mono text-xs text-gray-400 mb-3 leading-relaxed line-clamp-2 flex-1">${o.description||''}</p>
       ${o.hierarchy?`<div class="font-mono text-[10px] text-gray-500 mb-2 truncate"><i class="fas fa-sitemap mr-1"></i>${o.hierarchy}</div>`:''}
       <div class="grid grid-cols-2 gap-2 font-mono text-[10px] border-t border-gray-800 pt-3 mt-auto">
        <div><span class="text-gray-600 block mb-1">TERRITORY</span><span class="text-white truncate block">${(o.territories||[]).join(', ')}</span></div>
        <div><span class="text-gray-600 block mb-1">MEMBERS</span><span class="text-white">${o.memberCount!=null?o.memberCount:memberCount}</span></div>
       </div>
       ${avatars?`<div class="flex mt-3 pt-3 border-t border-gray-800 items-center">${avatars}${memberCount>5?`<span class="ml-3 font-mono text-[10px] text-gray-500">+${memberCount-5} more</span>`:''}</div>`:''}
       ${extLinks?`<div class="flex gap-2 mt-3 flex-wrap">${extLinks}</div>`:''}
      </div>
     </div>`;
    }).join('');
   },

   openOrgModal(id) {
    const o = DB.organizations.find(x=>x.id===id); if(!o) return; SFX.click();
    const members = DB.characters.filter(c=>(c.organizations||(c.organization?[c.organization]:[])).includes(o.id));
    const memberCards = members.map(c=>{
     const img = c.isClassified?'':(c.image||`https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=000&color=fff`);
     return `<div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800 cursor-pointer hover:border-cyber-blue transition-colors hover-sfx click-sfx" onclick="UI.closeOrgModal();setTimeout(()=>UI.openModal('${c.id}'),100)">
      ${img?`<img src="${img}" class="w-10 h-10 object-cover rounded-full border" style="border-color:${o.color}">`:`<div class="w-10 h-10 flex items-center justify-center border border-gray-700"><i class="fas fa-user-secret text-gray-600"></i></div>`}
      <div><div class="font-mono text-xs text-white">${c.isClassified?'[ REDACTED ]':c.name}</div><div class="font-mono text-[10px] text-gray-500">${c.alias||''}</div></div>
      <span class="ml-auto font-mono text-[10px] threat-${c.threatLevel}">${c.threatLevel}</span>
     </div>`;
    }).join('');
    const tags = (o.tags||[]).map(t=>`<span class="bg-black/60 border px-2 py-0.5 text-[10px] font-mono" style="border-color:${o.color}50;color:${o.color}">${t}</span>`).join('');
    let m = document.getElementById('org-modal');
    if(!m){
     m=document.createElement('div');
     m.id='org-modal';
     m.className='fixed inset-0 bg-black/90 z-[150] flex items-center justify-center p-4 overflow-y-auto';
     m.style.display='none';
     m.onclick = (e) => { if(e.target === m) UI.closeOrgModal(); };
     document.body.appendChild(m);
    }
    m.innerHTML=`<div class="glass-panel max-w-4xl w-full max-h-[90vh] overflow-y-auto relative border-t-4 mx-auto my-8" style="border-top-color:${o.color}">
     <div class="h-48 relative" style="${o.banner?`background:url('${o.banner}') center/cover`:`background:linear-gradient(135deg,${o.color}20,transparent)`}">
      <div class="absolute inset-0 bg-gradient-to-t from-black to-transparent"></div>
      <button onclick="UI.closeOrgModal()" class="absolute top-4 right-4 cyber-button px-3 py-2 text-xs z-10"><i class="fas fa-times"></i></button>
      ${o.image?`<img src="${o.image}" class="absolute bottom-4 left-8 w-20 h-20 object-contain">`:''}
      <div class="absolute bottom-4 ${o.image?'left-36':'left-8'}">
       <h2 class="font-display font-black text-4xl" style="color:${o.color}">${o.name}</h2>
       <div class="flex gap-2 mt-2">${tags}</div>
      </div>
     </div>
     <div class="p-8 grid grid-cols-1 md:grid-cols-3 gap-6">
      <div class="md:col-span-2 space-y-4">
       ${o.description?`<div><h3 class="font-mono text-xs text-gray-500 mb-2 tracking-widest">DESCRIPTION</h3><p class="font-mono text-sm text-gray-300 leading-relaxed">${o.description}</p></div>`:''}
       ${o.hierarchy?`<div><h3 class="font-mono text-xs text-gray-500 mb-2 tracking-widest">HIERARCHY</h3><p class="font-mono text-sm text-white">${o.hierarchy}</p></div>`:''}
       ${o.notes?`<div class="p-3 border border-cyber-red/30 bg-cyber-red/5"><h3 class="font-mono text-xs text-cyber-red mb-2 tracking-widest">CLASSIFIED NOTES</h3><p class="font-mono text-sm text-gray-300 italic">${o.notes}</p></div>`:''}
       ${members.length?`<div><h3 class="font-mono text-xs text-gray-500 mb-2 tracking-widest">OPERATIVES (${members.length})</h3><div class="space-y-2">${memberCards}</div></div>`:''}
      </div>
      <div class="space-y-4">
       <div class="glass-panel p-4 border border-gray-800">
        <h3 class="font-mono text-xs text-gray-500 mb-3 tracking-widest">INTEL</h3>
        <div class="space-y-2 font-mono text-xs">
         <div><span class="text-gray-600">STATUS</span><span class="ml-2" style="color:${o.color}">${o.status||'Active'}</span> <span class="font-mono text-[10px] border px-1" style="color:${{'Low':'#00ff66','Medium':'#facc15','High':'#f97316','Extreme':'#ff2a2a','Omega':'#cc00ff'}[o.threatLevel||'Low']||'#00ff66'};border-color:currentColor;opacity:.7">${o.threatLevel||'Low'}</span> <span class="font-mono text-[10px] border px-1" style="color:${{'Clean':'#00ff66','Low':'#facc15','Medium':'#f97316','High':'#ff2a2a','Most Wanted':'#ff0055'}[o.heatLevel||'Clean']||'#00ff66'};border-color:currentColor;opacity:.7">${o.heatLevel||'Clean'}</span></div>
         <div><span class="text-gray-600">TERRITORY</span><span class="ml-2 text-white">${(o.territories||[]).join(', ')}</span></div>
         <div><span class="text-gray-600">MEMBERS</span><span class="ml-2 text-white">${o.memberCount!=null?o.memberCount:members.length}</span></div>
        </div>
       </div>
       <button onclick="UI.closeOrgModal();UI.promptAdmin();setTimeout(()=>{Admin.switchTab('orgs');Admin.editOrg('${o.id}');},300)" class="w-full cyber-button px-4 py-2 text-xs click-sfx hover-sfx"><i class="fas fa-edit mr-2"></i>EDIT RECORD</button>
      </div>
     </div>
    </div>`;
    m.style.display='flex'; m.classList.remove('hidden');
   },
   openEventModal(id) {
    const ev = (DB.events||[]).find(x=>x.id===id); if(!ev) return; SFX.click();
    let m = document.getElementById('event-detail-modal');
    if(!m){m=document.createElement('div');m.id='event-detail-modal';m.className='fixed inset-0 bg-black/90 z-[150] flex items-center justify-center p-4';m.onclick=(e)=>{if(e.target===m)m.style.display='none';};document.body.appendChild(m);}
    const suspects=(ev.characters||[]).map(cid=>{const c=DB.characters.find(x=>x.id===cid);return c?`<span class="font-mono text-[10px] border border-gray-700 px-2 py-0.5 text-cyber-gold cursor-pointer hover:border-cyber-gold" onclick="document.getElementById('event-detail-modal').style.display='none';setTimeout(()=>UI.openModal('${cid}'),100)">${c.name}</span>`:''}).join('');
    m.innerHTML=`<div class="glass-panel max-w-xl w-full border-t-4 border-purple-500 mx-auto">
     <div class="p-6">
      <div class="flex justify-between items-start mb-4">
       <div><div class="flex items-center gap-2 mb-1"><i class="fas fa-${ev.icon||'bolt'} text-purple-400"></i><span class="font-mono text-[10px] text-gray-500">${ev.date||''}</span></div>
       <h2 class="font-display text-xl text-white font-black">${ev.title}</h2></div>
       <button onclick="document.getElementById('event-detail-modal').style.display='none'" class="cyber-button px-3 py-1 text-xs"><i class="fas fa-times"></i></button>
      </div>
      ${ev.description?`<p class="font-mono text-xs text-gray-300 leading-relaxed mb-4">${ev.description}</p>`:''}
      ${suspects?`<div><h3 class="font-mono text-xs text-gray-500 mb-2 tracking-widest">İLGİLİ KİŞİLER</h3><div class="flex flex-wrap gap-2">${suspects}</div></div>`:''}
      <div class="mt-4 pt-4 border-t border-gray-800 flex gap-2">
       <button onclick="document.getElementById('event-detail-modal').style.display='none';UI.promptAdmin();setTimeout(()=>{Admin.switchTab('chars');},300)" class="cyber-button px-3 py-1 text-xs click-sfx hover-sfx"><i class="fas fa-edit mr-1"></i>EDIT</button>
      </div>
     </div>
    </div>`;
    m.style.display='flex';
   },

   closeOrgModal(){
    const m=document.getElementById('org-modal');
    if(m) m.style.display='none';
   },

   renderRadar() {
    const container = document.getElementById('radar-pins');
    if(!container) return;
    container.innerHTML = '';
    
    const drawPin = (item, color, label, clickHandler) => {
     if(!item.mapX || !item.mapY) return; 
     const pin = document.createElement('div');
     pin.className = 'map-pin click-sfx hover-sfx';
     pin.style.backgroundColor = color;
     pin.style.boxShadow = `0 0 10px ${color}`;
     pin.style.left = `${item.mapX}%`;
     pin.style.top = `${item.mapY}%`;
     pin.onclick = (e) => { e.stopPropagation(); clickHandler(); };
     
     const tooltip = document.createElement('div');
     tooltip.className = 'map-tooltip';
     tooltip.style.borderColor = color;
     tooltip.innerText = label;
     pin.appendChild(tooltip);
     
     const ring = document.createElement('div');
     ring.className = 'map-ring';
     ring.style.borderColor = color;
     pin.appendChild(ring);

     container.appendChild(pin);
    };

    

    (DB.events || []).forEach(ev => {
     if(!ev.mapX || !ev.mapY) return;
     const epin = document.createElement('div');
     epin.className = 'map-event-pin';
     epin.style.left = `${ev.mapX}%`;
     epin.style.top  = `${ev.mapY}%`;
     epin.onclick = (e) => { e.stopPropagation(); UI.openEventModal(ev.id); };
     epin.innerHTML = `
      <div class="map-event-icon"><i class="fas fa-${ev.icon||'bolt'}"></i></div>
      <div class="map-tooltip"><strong>${ev.title}</strong><br>${ev.date||''}</div>
      <div class="map-event-dot"></div>`;
     container.appendChild(epin);
    });
    DB.properties.forEach(p => drawPin(p, 'var(--neon-purple)', `ASSET: ${p.name}`, () => UI.openPropertyModal(p.id)));
    DB.characters.forEach(c => {
     if(!c.mapX || !c.mapY) return;
     if(c.isClassified) {
      

      drawPin(c, 'var(--neon-red)', `[CLASSIFIED]`, () => {});
      return;
     }
     

     const pin = document.createElement('div');
     pin.className = 'map-pin map-avatar-pin click-sfx hover-sfx';
     pin.style.left = `${c.mapX}%`;
     pin.style.top = `${c.mapY}%`;
     pin.onclick = (e) => { e.stopPropagation(); UI.openModal(c.id); };

     

     const tColors = { Low:'var(--neon-green)', Medium:'#facc15', High:'#ff8c00', Extreme:'var(--neon-red)', Omega:'var(--neon-omega)' };
     const tColor = tColors[c.threatLevel] || 'var(--neon-blue)';

     

     const avatarSrc = c.image || `https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=000&color=fff&size=48`;
     pin.innerHTML = `
      <div class="map-avatar-ring" style="border-color:${tColor};box-shadow:0 0 8px ${tColor}60">
       <img src="${avatarSrc}" class="map-avatar-img" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="map-avatar-fallback" style="display:none;background:${tColor}20;color:${tColor}">${c.name.charAt(0).toUpperCase()}</div>
      </div>
      <div class="map-tooltip" style="border-color:${tColor}">
       <span class="font-bold">${c.name}</span>${c.alias ? ` <span class="opacity-60">/ ${c.alias}</span>` : ''}
       <span class="map-tooltip-threat" style="color:${tColor}">${c.threatLevel||''}</span>
      </div>
      <div class="map-avatar-dot" style="background:${tColor};box-shadow:0 0 6px ${tColor}"></div>`;
     container.appendChild(pin);
    });
    DB.vehicles.forEach(v => drawPin(v, 'var(--neon-gold)', `VEH: ${v.plate || v.model}`, () => UI.openVehicleModal(v.id)));
   },

   renderContracts() {
    const grid = document.getElementById('contract-grid');
    if(!grid) return;
    const sq = activeFilters.search||'';
    const visible = DB.contracts.filter(c=>!c.archived && (!sq || c.target?.toLowerCase().includes(sq) || c.issuer?.toLowerCase().includes(sq) || c.desc?.toLowerCase().includes(sq) || (c.tags||[]).some(t=>t.toLowerCase().includes(sq))));
    if(!visible.length){grid.innerHTML='<div class="col-span-3 text-center font-mono text-gray-600 py-16"><i class="fas fa-crosshairs text-4xl mb-4 block opacity-30"></i>NO ACTIVE CONTRACTS</div>';return;}
    const sMap={Open:'text-cyber-gold',Assigned:'text-cyber-blue','In Progress':'text-purple-400',Completed:'text-cyber-green',Failed:'text-cyber-red',Cancelled:'text-gray-500'};
    const bMap={Open:'border-cyber-red',Assigned:'border-cyber-blue','In Progress':'border-purple-500',Completed:'border-cyber-green',Failed:'border-gray-700',Cancelled:'border-gray-800'};
    const rColor={Low:'text-cyber-green',Medium:'text-yellow-400',High:'text-orange-500',Critical:'text-cyber-red'};
    const rIcon={Low:'fa-shield-alt',Medium:'fa-exclamation-circle',High:'fa-exclamation-triangle',Critical:'fa-skull'};
    grid.innerHTML = visible.map(con => {
     const ac = DB.characters.find(c=>c.id===con.assigned);
     const aName = ac?(ac.isClassified?'[ REDACTED ]':ac.name):'UNASSIGNED';
     const sc = sMap[con.status]||'text-cyber-gold';
     const bc = bMap[con.status]||'border-cyber-red';
     const risk = con.riskLevel||'Medium';
     const rc = rColor[risk]||'text-yellow-400';
     const ri = rIcon[risk]||'fa-exclamation-circle';
     const tags = (con.tags||[]).map(t=>`<span class="bg-black/50 border border-cyber-red/30 text-cyber-red/70 font-mono text-[9px] px-1.5 py-0.5 uppercase">${t}</span>`).join('');
     return `<div class="glass-panel cyber-border p-5 border-l-4 ${bc} hover-sfx cursor-pointer transition-all hover:shadow-[0_0_20px_rgba(255,42,42,0.15)]" onclick="UI.openContractModal('${con.id}')">
      <div class="flex justify-between items-start mb-3 gap-2">
       <h3 class="font-display font-bold text-lg text-white leading-tight">${con.target}</h3>
       <span class="${sc} font-bold text-[10px] uppercase tracking-widest border border-gray-700 bg-black/50 px-2 py-1 flex-shrink-0">${con.status}</span>
      </div>
      <p class="font-mono text-xs text-gray-400 mb-3 line-clamp-2">${con.desc||''}</p>
      ${tags?`<div class="flex gap-1 flex-wrap mb-3">${tags}</div>`:''}
      <div class="grid grid-cols-2 gap-2 font-mono text-[10px] tracking-widest border-t border-gray-800 pt-3">
       <div><span class="text-gray-600 block mb-1">ISSUER</span><span class="text-white truncate block">${con.issuer||'—'}</span></div>
       <div><span class="text-gray-600 block mb-1">REWARD</span><span class="text-cyber-green font-bold">${con.reward||'—'}</span></div>
       <div><span class="text-gray-600 block mb-1">RISK</span><span class="${rc}"><i class="fas ${ri} mr-1"></i>${risk}</span></div>
       <div><span class="text-gray-600 block mb-1">OPERATIVE</span><span class="text-cyber-blue truncate block">${aName}</span></div>
       ${con.deadline?`<div class="col-span-2 mt-1"><span class="text-gray-600 block mb-1">DEADLINE</span><span class="text-yellow-400 font-bold">${con.deadline}</span></div>`:''}
      </div>
     </div>`;
    }).join('');
   },

   openContractModal(id) {
    const con = DB.contracts.find(x=>x.id===id); if(!con) return; SFX.click();
    const ac = DB.characters.find(c=>c.id===con.assigned);
    const aName = ac ? (ac.isClassified?'[ REDACTED ]':ac.name) : 'UNASSIGNED';
    const aImg  = ac && !ac.isClassified && ac.image ? ac.image : null;

    

    const sColors={Open:'text-cyber-gold',Assigned:'text-cyber-blue','In Progress':'text-purple-400',Completed:'text-cyber-green',Failed:'text-cyber-red',Cancelled:'text-gray-500'};
    const rColors={Low:'text-cyber-green',Medium:'text-yellow-400',High:'text-orange-500',Critical:'text-cyber-red'};
    const rIcons ={Low:'fa-shield-alt',Medium:'fa-exclamation-circle',High:'fa-exclamation-triangle',Critical:'fa-skull'};

    

    const suspects = (con.suspects||[]).map(cid=>{
     const c=DB.characters.find(x=>x.id===cid); if(!c) return '';
     const img=c.image||`https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=000&color=fff`;
     return `<div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800 cursor-pointer hover:border-cyber-blue transition-colors" onclick="UI.closeContractModal();setTimeout(()=>UI.openModal('${c.id}'),100)">
      <img src="${img}" class="w-9 h-9 rounded-full object-cover border border-gray-700">
      <div><div class="font-mono text-xs text-white">${c.isClassified?'[ REDACTED ]':c.name}</div><div class="font-mono text-[9px] text-gray-500">${c.alias||''}</div></div>
      <span class="ml-auto font-mono text-[10px] threat-${c.threatLevel}">${c.threatLevel}</span>
     </div>`;
    }).join('');

    

    const orgs = (con.linkedOrgs||[]).map(oid=>{
     const o=DB.organizations.find(x=>x.id===oid); if(!o) return '';
     return `<span class="font-mono text-[10px] border px-2 py-1" style="color:${o.color};border-color:${o.color}50">${o.name}</span>`;
    }).join('');

    

    const evRows = (con.evidence||[]).map(ev=>{
     const sc={Secured:'text-cyber-green',Pending:'text-yellow-400',Lost:'text-cyber-red',Classified:'text-purple-400'}[ev.status]||'text-gray-400';
     return `<div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800">
      <i class="fas fa-file-alt text-gray-600 w-4"></i>
      <span class="font-mono text-xs text-white flex-1">${ev.label||ev}</span>
      <span class="${sc} font-mono text-[10px]">${ev.status||''}</span>
      ${ev.url?`<a href="${ev.url}" target="_blank" class="text-cyber-blue text-[10px]"><i class="fas fa-link"></i></a>`:''}
     </div>`;
    }).join('');

    

    const tlRows = (con.timeline||[]).sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map((ev,i,arr)=>
     `<div class="flex gap-3"><div class="flex flex-col items-center">
      <div class="w-3 h-3 rounded-full bg-cyber-blue border-2 border-cyber-blue/50 flex-shrink-0 mt-1"></div>
      ${i<arr.length-1?'<div class="w-px flex-1 bg-gray-800 mt-1"></div>':''}
     </div><div class="pb-4">
      <span class="font-mono text-[10px] text-gray-500">${ev.date||'—'}</span>
      <p class="font-mono text-xs text-gray-300 mt-0.5">${ev.event||ev}</p>
     </div></div>`
    ).join('');

    

    const tags = (con.tags||[]).map(t=>`<span class="bg-black/50 border border-cyber-red/30 text-cyber-red/70 font-mono text-[9px] px-2 py-0.5 uppercase">${t}</span>`).join('');

    let m = document.getElementById('contract-detail-modal');
    if(!m){
     m=document.createElement('div');
     m.id='contract-detail-modal';
     m.className='fixed inset-0 bg-black/90 z-[150] flex items-start justify-center p-4 overflow-y-auto';
     m.onclick=(e)=>{if(e.target===m)m.style.display='none';};
     document.body.appendChild(m);
    }

    m.innerHTML=`<div class="glass-panel max-w-4xl w-full border-t-4 border-cyber-red relative mx-auto my-8">
     
     <div class="p-6 border-b border-gray-800">
      <div class="flex justify-between items-start gap-4">
       <div class="flex-1 min-w-0">
        <div class="flex items-center gap-3 mb-2 flex-wrap">
         <span class="font-mono text-[10px] text-gray-500 tracking-widest">CONTRACT #${con.id.slice(-8).toUpperCase()}</span>
         <span class="${sColors[con.status]||'text-cyber-gold'} font-mono text-[10px] font-bold uppercase border border-current px-2 py-0.5">${con.status}</span>
         <span class="${rColors[con.riskLevel||'Medium']||'text-yellow-400'} font-mono text-[10px]"><i class="fas ${rIcons[con.riskLevel||'Medium']||'fa-exclamation-circle'} mr-1"></i>${con.riskLevel||'Medium'} RISK</span>
        </div>
        <h2 class="font-display font-black text-3xl text-white truncate">${con.target}</h2>
        ${tags?`<div class="flex gap-1 flex-wrap mt-2">${tags}</div>`:''}
       </div>
       <button onclick="UI.closeContractModal()" class="cyber-button px-3 py-2 text-xs flex-shrink-0 click-sfx"><i class="fas fa-times"></i></button>
      </div>
     </div>

     
     <div class="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">

      
      <div class="space-y-4">
       
       <div class="glass-panel p-4 border border-gray-800 space-y-3 font-mono text-xs">
        <div><span class="text-gray-500 block mb-1">ISSUER</span><span class="text-white font-bold">${con.issuer||'—'}</span></div>
        <div><span class="text-gray-500 block mb-1">REWARD</span><span class="text-cyber-green font-bold text-sm">${con.reward||'—'}</span></div>
        ${con.deadline?`<div><span class="text-gray-500 block mb-1">DEADLINE</span><span class="text-yellow-400 font-bold">${con.deadline}</span></div>`:''}
        ${con.location?`<div><span class="text-gray-500 block mb-1">LOCATION</span><span class="text-white">${con.location}</span></div>`:''}
       </div>

       
       <div class="glass-panel p-4 border border-gray-800">
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-3">ASSIGNED OPERATIVE</div>
        ${aImg
         ? `<div class="flex items-center gap-3 cursor-pointer hover:opacity-80" onclick="UI.closeContractModal();setTimeout(()=>UI.openModal('${ac.id}'),100)">
          <img src="${aImg}" class="w-12 h-12 rounded-full object-cover border-2 border-cyber-blue">
          <div><div class="font-mono text-sm text-white font-bold">${aName}</div><div class="font-mono text-[10px] text-gray-500">${ac.alias||''}</div></div>
         </div>`
         : `<div class="font-mono text-sm ${ac?'text-cyber-blue':'text-gray-600'}">${aName}</div>`
        }
       </div>

       
       ${orgs?`<div class="glass-panel p-4 border border-gray-800">
        <div class="font-mono text-[10px] text-gray-500 tracking-widest mb-3">RELATED ORGS</div>
        <div class="flex flex-wrap gap-2">${orgs}</div>
       </div>`:''}

       
       ${con.outcome?`<div class="p-3 border border-cyber-green/30 bg-cyber-green/5">
        <div class="font-mono text-[10px] text-cyber-green tracking-widest mb-2">OUTCOME</div>
        <p class="font-mono text-xs text-gray-300">${con.outcome}</p>
       </div>`:''}

       
       <button onclick="UI.closeContractModal();UI.promptAdmin();setTimeout(()=>{Admin.switchTab('contracts');Admin.editContract('${con.id}');},300)" class="w-full cyber-button px-4 py-2 text-xs click-sfx hover-sfx"><i class="fas fa-edit mr-2"></i>DÜZENLE</button>
      </div>

      
      <div class="md:col-span-2 space-y-5">
       ${con.briefing?`<div><div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">BRIEFING</div><p class="font-mono text-xs text-gray-300 leading-relaxed whitespace-pre-line">${con.briefing}</p></div>`:''}
       ${con.desc?`<div><div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">CONTRACT DETAILS</div><p class="font-mono text-xs text-gray-300 leading-relaxed">${con.desc}</p></div>`:''}
       ${con.notes?`<div class="p-3 border border-cyber-red/30 bg-cyber-red/5"><div class="font-mono text-[10px] text-cyber-red tracking-widest mb-2">CLASSIFIED NOTES</div><p class="font-mono text-xs text-gray-300">${con.notes}</p></div>`:''}

       ${suspects?`<div><div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">SUSPECTS / PERSONS OF INTEREST</div><div class="space-y-2">${suspects}</div></div>`:''}

       ${evRows?`<div><div class="font-mono text-[10px] text-gray-500 tracking-widest mb-2">EVIDENCE</div><div class="space-y-1">${evRows}</div></div>`:''}

       ${tlRows?`<div><div class="font-mono text-[10px] text-gray-500 tracking-widest mb-3">TIMELINE</div><div>${tlRows}</div></div>`:''}

       ${con.link?`<a href="${con.link}" target="_blank" class="cyber-button px-4 py-2 text-xs inline-flex items-center gap-2 click-sfx hover-sfx"><i class="fas fa-external-link-alt"></i>EXTERNAL REFERENCE</a>`:''}
      </div>
     </div>
    </div>`;

    m.style.display='flex';
   },

   closeContractModal() {
    const m=document.getElementById('contract-detail-modal');
    if(m) m.style.display='none';
   },

   renderCases() {
    const grid = document.getElementById('case-grid');
    if(!grid) return;
    const csq = activeFilters.search||'';
    const visible = DB.cases.filter(cf=>!cf.archived && (!csq || cf.title?.toLowerCase().includes(csq) || cf.content?.toLowerCase().includes(csq) || (cf.tags||[]).some(t=>t.toLowerCase().includes(csq))));
    if(!visible.length){grid.innerHTML='<div class="col-span-2 text-center font-mono text-gray-600 py-16"><i class="fas fa-folder-open text-4xl mb-4 block opacity-30"></i>NO ACTIVE CASE FILES</div>';return;}
    const pColors={Low:'text-cyber-green',Medium:'text-yellow-400',High:'text-orange-500',Critical:'text-cyber-red',Omega:'text-purple-400'};
    const pIcons={Low:'fa-circle',Medium:'fa-exclamation-circle',High:'fa-exclamation-triangle',Critical:'fa-radiation-alt',Omega:'fa-skull-crossbones'};
    const sColors={Open:'text-cyber-gold',Active:'text-cyber-blue',Closed:'text-gray-500',Cold:'text-cyan-700',Archived:'text-gray-600'};
    const bColors={Low:'border-cyber-green',Medium:'border-cyber-gold',High:'border-orange-500',Critical:'border-cyber-red',Omega:'border-purple-500'};
    grid.innerHTML = visible.map(cf => {
     const priority=cf.priority||'Medium', status=cf.status||'Open';
     const pc=pColors[priority]||'text-yellow-400', pi=pIcons[priority]||'fa-exclamation-circle';
     const sc=sColors[status]||'text-cyber-gold', bc=bColors[priority]||'border-cyber-gold';
     const suspects=(cf.tags||cf.suspects||[]);
     const tagHtml=suspects.slice(0,4).map(tId=>{const tc=DB.characters.find(c=>c.id===tId);const tn=tc?(tc.isClassified?'[ REDACTED ]':tc.name):tId;return `<span class="bg-black/50 border border-gray-700 px-2 py-0.5 text-[9px] text-cyber-gold font-mono uppercase cursor-pointer hover:border-cyber-gold click-sfx hover-sfx" onclick="event.stopPropagation();UI.openModal('${tId}')">${tn}</span>`;}).join('');
     const more=suspects.length-4;
     return `<div class="glass-panel cyber-border border-l-4 ${bc} hover-sfx cursor-pointer transition-all hover:shadow-[0_0_20px_rgba(255,215,0,0.1)]" onclick="UI.openCaseModal('${cf.id}')">
      <div class="p-5">
       <div class="flex justify-between items-start mb-3 gap-2">
        <div class="flex-1 min-w-0">
         <div class="flex items-center gap-2 mb-1">
          <i class="fas fa-folder text-cyber-gold opacity-60 text-sm"></i>
          <span class="font-mono text-[10px] text-gray-500 tracking-widest">CASE #${cf.id.slice(-6).toUpperCase()}</span>
          <span class="${sc} font-mono text-[10px] uppercase tracking-widest">${status}</span>
         </div>
         <h3 class="font-display font-bold text-lg text-cyber-gold leading-tight truncate">${cf.title}</h3>
        </div>
        <div class="flex flex-col items-end gap-1 flex-shrink-0">
         <span class="${pc} font-mono text-[10px] uppercase font-bold"><i class="fas ${pi} mr-1"></i>${priority}</span>
         <span class="text-gray-600 font-mono text-[9px]">${cf.date||''}</span>
        </div>
       </div>
       <p class="font-mono text-xs text-gray-400 leading-relaxed line-clamp-2 mb-3">${cf.content||''}</p>
       ${tagHtml?`<div class="flex flex-wrap gap-1 mb-3">${tagHtml}${more>0?`<span class="font-mono text-[9px] text-gray-600 self-center">+${more}</span>`:''}</div>`:''}
       <div class="grid grid-cols-4 gap-2 font-mono text-[10px] border-t border-gray-800 pt-3 text-center">
        <div><span class="text-cyber-red block font-bold">${suspects.length}</span><span class="text-gray-600">SUSPECTS</span></div>
        <div><span class="text-cyber-blue block font-bold">${(cf.evidence||[]).length}</span><span class="text-gray-600">EVIDENCE</span></div>
        <div><span class="text-purple-400 block font-bold">${(cf.timeline||[]).length}</span><span class="text-gray-600">EVENTS</span></div>
        <div><span class="text-cyber-green block font-bold">${(cf.assignedAgents||[]).length}</span><span class="text-gray-600">AGENTS</span></div>
       </div>
      </div>
     </div>`;
    }).join('');
   },

   openCaseModal(id) {
    const cf = DB.cases.find(x=>x.id===id); if(!cf) return; SFX.click();
    const pColors={Low:'text-cyber-green',Medium:'text-yellow-400',High:'text-orange-500',Critical:'text-cyber-red',Omega:'text-purple-400'};
    const priority=cf.priority||'Medium', status=cf.status||'Open';
    const suspects=(cf.tags||cf.suspects||[]).map(tId=>{
     const tc=DB.characters.find(c=>c.id===tId);
     const tn=tc?(tc.isClassified?'[ REDACTED ]':tc.name):tId;
     const img=tc&&!tc.isClassified&&tc.image?`<img src="${tc.image}" class="w-8 h-8 object-cover rounded-full border border-gray-700">`:`<div class="w-8 h-8 flex items-center justify-center border border-gray-700 text-gray-600"><i class="fas fa-user text-xs"></i></div>`;
     return `<div class="flex items-center gap-2 p-2 bg-black/40 border border-gray-800 cursor-pointer hover:border-cyber-gold transition-colors hover-sfx click-sfx" onclick="UI.closeCaseModal();setTimeout(()=>UI.openModal('${tId}'),100)">${img}<div class="font-mono text-xs text-white flex-1">${tn}</div>${tc?`<span class="font-mono text-[10px] threat-${tc.threatLevel}">${tc.threatLevel}</span>`:''}</div>`;
    }).join('');
    const agents=(cf.assignedAgents||[]).map(aId=>{const ac=DB.characters.find(c=>c.id===aId);return ac?`<span class="bg-cyber-blue/10 border border-cyber-blue/30 text-cyber-blue font-mono text-[10px] px-2 py-1">${ac.isClassified?'[ REDACTED ]':ac.name}</span>`:''}).join('');
    const relOrgs=(cf.relatedOrgs||[]).map(oId=>{const o=DB.organizations.find(x=>x.id===oId);return o?`<span class="font-mono text-[10px] border px-2 py-1" style="color:${o.color};border-color:${o.color}50">${o.name}</span>`:''}).join('');
    const evidence=(cf.evidence||[]).map(ev=>{const sc={Secured:'text-cyber-green',Pending:'text-yellow-400',Lost:'text-cyber-red',Classified:'text-purple-400'}[ev.status]||'text-gray-400';return `<div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800"><i class="fas fa-file-alt text-gray-600"></i><span class="font-mono text-xs text-white flex-1">${ev.label||ev}</span><span class="${sc} font-mono text-[10px]">${ev.status||''}</span>${ev.url?`<a href="${ev.url}" target="_blank" class="text-cyber-blue text-[10px]"><i class="fas fa-link"></i></a>`:''}</div>`;}).join('');
    const timeline=(cf.timeline||[]).sort((a,b)=>(a.date||'').localeCompare(b.date||'')).map((ev,i,arr)=>`<div class="flex gap-3"><div class="flex flex-col items-center"><div class="w-3 h-3 rounded-full bg-cyber-blue border-2 border-cyber-blue/50 flex-shrink-0 mt-1"></div>${i<arr.length-1?'<div class="w-px flex-1 bg-gray-800 mt-1"></div>':''}</div><div class="pb-4"><span class="font-mono text-[10px] text-gray-500">${ev.date||'—'}</span><p class="font-mono text-xs text-gray-300 mt-0.5">${ev.event||ev}</p></div></div>`).join('');
    let m=document.getElementById('case-detail-modal');
    if(!m){
     m=document.createElement('div');
     m.id='case-detail-modal';
     m.className='fixed inset-0 bg-black/90 z-[150] flex items-start justify-center p-4 overflow-y-auto';
     m.style.display='none';
     m.onclick = (e) => { if(e.target === m) UI.closeCaseModal(); };
     document.body.appendChild(m);
    }
    m.innerHTML=`<div class="glass-panel max-w-4xl w-full max-h-[90vh] overflow-y-auto border-t-4 border-cyber-gold relative mx-auto my-8">
     <div class="p-6">
      <div class="flex justify-between items-start mb-4 border-b border-gray-800 pb-4">
       <div>
        <div class="flex items-center gap-3 mb-1">
         <span class="font-mono text-[10px] text-gray-500 tracking-widest">CASE #${cf.id.slice(-8).toUpperCase()}</span>
         <span class="${pColors[priority]||'text-yellow-400'} font-mono text-[10px] font-bold uppercase">${priority} PRIORITY</span>
         <span class="font-mono text-[10px] text-cyber-blue uppercase">${status}</span>
        </div>
        <h2 class="font-display text-2xl text-cyber-gold font-black">${cf.title}</h2>
        <p class="font-mono text-[10px] text-gray-500 mt-1">${cf.date||''}</p>
       </div>
       <button onclick="UI.closeCaseModal()" class="cyber-button px-3 py-2 text-xs flex-shrink-0"><i class="fas fa-times"></i></button>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
       <div class="md:col-span-2 space-y-5">
        ${cf.content?`<div><h3 class="font-mono text-xs text-gray-500 tracking-widest mb-2">CASE SUMMARY</h3><p class="font-mono text-xs text-gray-300 leading-relaxed whitespace-pre-line">${cf.content}</p></div>`:''}
        ${cf.notes?`<div class="p-3 border border-cyber-red/30 bg-cyber-red/5"><h3 class="font-mono text-xs text-cyber-red tracking-widest mb-2">CLASSIFIED NOTES</h3><p class="font-mono text-xs text-gray-300">${cf.notes}</p></div>`:''}
        ${suspects?`<div><h3 class="font-mono text-xs text-gray-500 tracking-widest mb-2">SUSPECTS / PERSONS OF INTEREST</h3><div class="space-y-2">${suspects}</div></div>`:''}
        ${evidence?`<div><h3 class="font-mono text-xs text-gray-500 tracking-widest mb-2">EVIDENCE</h3><div class="space-y-1">${evidence}</div></div>`:''}
        ${timeline?`<div><h3 class="font-mono text-xs text-gray-500 tracking-widest mb-3">TIMELINE</h3><div>${timeline}</div></div>`:''}
       </div>
       <div class="space-y-4">
        ${agents?`<div class="glass-panel p-4 border border-gray-800"><h3 class="font-mono text-xs text-gray-500 mb-3 tracking-widest">ASSIGNED AGENTS</h3><div class="flex flex-wrap gap-2">${agents}</div></div>`:''}
        ${relOrgs?`<div class="glass-panel p-4 border border-gray-800"><h3 class="font-mono text-xs text-gray-500 mb-3 tracking-widest">RELATED ORGS</h3><div class="flex flex-wrap gap-2">${relOrgs}</div></div>`:''}
        ${(cf.externalRefs||[]).length?`<div class="glass-panel p-4 border border-gray-800"><h3 class="font-mono text-xs text-gray-500 mb-3 tracking-widest">REFERENCES</h3>${(cf.externalRefs).map(r=>`<a href="${typeof r==='string'?r:r.url||'#'}" target="_blank" class="block cyber-button px-3 py-1 text-[10px] mb-1 hover-sfx truncate"><i class="fas fa-link mr-1"></i>${typeof r==='string'?r:r.label||r.url}</a>`).join('')}</div>`:''}
        <button onclick="UI.closeCaseModal();UI.promptAdmin();setTimeout(()=>{Admin.switchTab('cases');Admin.editCase('${cf.id}');},300)" class="w-full cyber-button px-4 py-2 text-xs click-sfx hover-sfx"><i class="fas fa-edit mr-2"></i>EDIT CASE FILE</button>
       </div>
      </div>
     </div>
    </div>`;
    m.style.display='flex';
   },
   closeCaseModal(){const m=document.getElementById('case-detail-modal');if(m)m.style.display='none';},

   renderVehicles() {
    const dict = i18n[currentLang];
    const grid = document.getElementById('vehicle-grid');
    if(!grid) return;
    let count = 0;
    grid.innerHTML = DB.vehicles.filter(v => {
     if (!activeFilters.heat.has('all') && !activeFilters.heat.has(v.heatLevel)) return false;
     if (activeFilters.search && !v.model.toLowerCase().includes(activeFilters.search)) return false;
     count++; return true;
    }).map(v => {
     const owner = DB.characters.find(c => c.id === v.owner);
     const ownerName = owner ? (owner.isClassified ? '[ REDACTED ]' : owner.name) : dict.unregistered;
     const img = v.image || 'https://via.placeholder.com/600x300/0a0a0c/00a2ff?text=NO+VISUAL+DATA';
     const isHot = v.heatLevel === 'High' || v.heatLevel === 'Most Wanted';

     return `
     <div onclick="UI.openVehicleModal('${v.id}')" class="glass-panel cyber-border flex flex-col group overflow-hidden cursor-pointer hover:border-cyber-blue transition-colors hover-sfx click-sfx">
      <div class="h-48 overflow-hidden bg-black border-b border-gray-800 relative">
       <img src="${img}" class="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500 mix-blend-luminosity group-hover:mix-blend-normal">
       <div class="absolute inset-0 bg-cyber-blue/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
       ${isHot ? '<div class="absolute inset-0 bg-cyber-red/10 animate-pulse pointer-events-none"></div>' : ''}
      </div>
      <div class="p-5 flex flex-col flex-1 justify-between">
       <h3 class="font-display font-bold text-lg text-cyber-blue mb-4">${v.model}</h3>
       <div class="grid grid-cols-2 gap-2 font-mono text-[10px] tracking-widest">
        <div class="bg-black/50 p-2"><span class="text-gray-600 block mb-1">${dict.plate}</span> <span class="text-white">${v.plate || dict.none}</span></div>
        <div class="bg-black/50 p-2"><span class="text-gray-600 block mb-1">${dict.owner}</span> <span class="text-cyber-green truncate block">${ownerName}</span></div>
        <div class="bg-black/50 p-2 col-span-2"><span class="text-gray-600 block mb-1">${dict.specs}</span> <span class="text-gray-300 truncate block">${v.perf || dict.classified}</span></div>
       </div>
      </div>
     </div>`;
    }).join('');
    const counter = document.getElementById('counter-vehicles');
    if(counter) counter.innerText = `${count} ${dict.matches}`;
   },

   renderProperties() {
    const dict = i18n[currentLang];
    const grid = document.getElementById('property-grid');
    if(!grid) return;
    let count = 0;
    grid.innerHTML = DB.properties.filter(p => {
     if(activeFilters.search && !p.name.toLowerCase().includes(activeFilters.search)) return false;
     count++; return true;
    }).map(p => {
     const owner = DB.characters.find(c => c.id === p.owner);
     const ownerName = owner ? (owner.isClassified ? '[ REDACTED ]' : owner.name) : dict.classified;
     const img = p.image || 'https://via.placeholder.com/600x400/0a0a0c/b026ff?text=NO+VISUAL+DATA';
     return `
     <div onclick="UI.openPropertyModal('${p.id}')" class="glass-panel cyber-border flex flex-col md:flex-row group overflow-hidden cursor-pointer hover:border-cyber-purple transition-colors hover-sfx click-sfx">
      <div class="w-full md:w-2/5 h-40 md:h-auto overflow-hidden border-b md:border-b-0 md:border-r border-gray-800 bg-black relative">
       <img src="${img}" class="w-full h-full object-cover opacity-40 group-hover:opacity-100 transition-all duration-500 mix-blend-luminosity group-hover:mix-blend-normal">
       <div class="absolute inset-0 bg-cyber-purple/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
      </div>
      <div class="w-full md:w-3/5 p-5 flex flex-col justify-center">
       <h3 class="font-display font-bold text-lg text-cyber-purple mb-1">${p.name}</h3>
       <p class="font-mono text-xs text-gray-400 mb-4 h-8 overflow-hidden">${p.desc || ''}</p>
       <div class="space-y-1 font-mono text-[10px] tracking-widest border-t border-gray-800 pt-3">
        <div class="flex justify-between"><span class="text-gray-600">${dict.loc}</span> <span class="text-white">${p.location}</span></div>
        <div class="flex justify-between"><span class="text-gray-600">${dict.type}</span> <span class="text-gray-300">${p.type}</span></div>
        <div class="flex justify-between"><span class="text-gray-600">${dict.owner}</span> <span class="text-cyber-green truncate max-w-[120px] text-right">${ownerName}</span></div>
       </div>
      </div>
     </div>`;
    }).join('');
    const counter = document.getElementById('counter-properties');
    if(counter) counter.innerText = `${count} ${dict.matches}`;
   },

   renderEquipments() {
    const dict = i18n[currentLang];
    const grid = document.getElementById('equipment-grid');
    if(!grid) return;
    let count = 0;
    grid.innerHTML = DB.equipments.filter(e => {
     if(activeFilters.search && !e.name.toLowerCase().includes(activeFilters.search)) return false;
     count++; return true;
    }).map(e => {
     const owner = DB.characters.find(c => c.id === e.owner);
     const ownerName = owner ? (owner.isClassified ? '[ REDACTED ]' : owner.name) : dict.unregistered;
     const img = e.image || 'https://via.placeholder.com/600x400/0a0a0c/ff0055?text=NO+VISUAL+DATA';
     return `
     <div onclick="UI.openEquipmentModal('${e.id}')" class="glass-panel cyber-border flex flex-col group overflow-hidden cursor-pointer hover:border-cyber-omega transition-colors hover-sfx click-sfx">
      <div class="h-40 overflow-hidden bg-black border-b border-gray-800 relative">
       <img src="${img}" class="w-full h-full object-cover opacity-60 group-hover:opacity-100 transition-opacity duration-500 mix-blend-luminosity group-hover:mix-blend-normal">
       <div class="absolute inset-0 bg-cyber-omega/10 opacity-0 group-hover:opacity-100 transition-opacity"></div>
      </div>
      <div class="p-5 flex flex-col flex-1 justify-between">
       <h3 class="font-display font-bold text-lg text-cyber-omega mb-2">${e.name}</h3>
       <div class="grid grid-cols-2 gap-2 font-mono text-[10px] tracking-widest">
        <div class="bg-black/50 p-2"><span class="text-gray-600 block mb-1">${dict.type}</span> <span class="text-gray-300 uppercase">${e.type || dict.classified}</span></div>
        <div class="bg-black/50 p-2"><span class="text-gray-600 block mb-1">${dict.owner}</span> <span class="text-cyber-green truncate block">${ownerName}</span></div>
        <div class="bg-black/50 p-2 col-span-2"><span class="text-gray-600 block mb-1">${dict.specs}</span> <span class="text-gray-400 truncate block">${e.desc || 'No details'}</span></div>
       </div>
      </div>
     </div>`;
    }).join('');
    const counter = document.getElementById('counter-equipments');
    if(counter) counter.innerText = `${count} ${dict.matches}`;
   },

   renderLogs() {
    const ticker = document.getElementById('live-feed-ticker');
    if(!ticker) return;
    
    if (!DB.logs || DB.logs.length === 0) {
     ticker.innerHTML = '';
     return;
    }

    const logTypeTrans = {
     'INTEL': currentLang === 'tr' ? 'İSTİHBARAT' : 'INTEL',
     'WARNING': currentLang === 'tr' ? 'UYARI' : 'WARNING',
     'SYSTEM': currentLang === 'tr' ? 'SİSTEM' : 'SYSTEM'
    };

    let logHtml = '';
    DB.logs.forEach(l => {
     let color = 'text-cyber-blue';
     if(l.type === 'WARNING') color = 'text-cyber-red';
     if(l.type === 'SYSTEM') color = 'text-cyber-green';
     let displayType = logTypeTrans[l.type] || l.type;
     logHtml += `<span class="px-8 border-l border-gray-800 whitespace-nowrap"><span class="text-gray-600 mr-2">[${l.time}]</span> <span class="${color} font-bold mr-2">${displayType}:</span> <span class="text-gray-300">${l.text}</span></span>`;
    });

    (DB.events||[]).forEach(ev=>{logHtml+=`<span class="px-8 border-l border-gray-800 whitespace-nowrap cursor-pointer hover:opacity-80" onclick="UI.switchTab('radar')"><span class="text-gray-600 mr-2">[${ev.date||'—'}]</span><span class="font-bold mr-2" style="color:${ev.color||'#a855f7'}"><i class="fas fa-${ev.icon||'bolt'} mr-1"></i>OLAY:</span><span class="text-gray-300">${ev.title||''}</span></span>`;});
    

    let block = `<div class="flex items-center pr-8">${logHtml.repeat(5)}</div>`;
    ticker.innerHTML = block + block;
   },

   exportPDF() {
    if(!currentOpenedChar) return;
    const c = currentOpenedChar;
    SFX.hover();
    
    const dict = i18n[currentLang];
    document.getElementById('pdf-id').innerText = (c.id || "").toUpperCase();
    document.getElementById('pdf-date').innerText = new Date().toISOString().split('T')[0];
    document.getElementById('pdf-img').src = c.image || `https://ui-avatars.com/api/?name=${c.name}&background=000&color=fff&size=512`;
    
    document.getElementById('pdf-name').innerText = c.name;
    document.getElementById('pdf-alias').innerText = c.alias || 'N/A';
    document.getElementById('pdf-org').innerText = this.getOrg(c.organization).name;
    document.getElementById('pdf-status').innerText = dict[c.status.toLowerCase()] || c.status;
    document.getElementById('pdf-threat').innerText = dict[c.threatLevel.toLowerCase()] || c.threatLevel;
    document.getElementById('pdf-heat').innerText = dict[c.heatLevel.toLowerCase().replace(' ', '_')] || c.heatLevel;
    document.getElementById('pdf-story').innerText = c.story || 'No data.';

    const relsHTML = (c.relationships || []).map(r => {
     const t = DB.characters.find(x => x.id === r.targetId);
     return `<li><b>${t ? t.name : 'Unknown'}</b> - ${r.type}</li>`;
    }).join('') || '<li>None</li>';
    document.getElementById('pdf-rels').innerHTML = relsHTML;

    
    const vehs = DB.vehicles.filter(v => v.owner === c.id);
    const props = DB.properties.filter(p => p.owner === c.id);
    const eqs = DB.equipments.filter(e => e.owner === c.id);
    let assetsHTML = '';
    vehs.forEach(v => assetsHTML += `<li>[VEHICLE] ${v.model} (${v.plate})</li>`);
    props.forEach(p => assetsHTML += `<li>[PROPERTY] ${p.name} (${p.type})</li>`);
    eqs.forEach(e => assetsHTML += `<li>[GEAR] ${e.name} (${e.type})</li>`);
    if(assetsHTML === '') assetsHTML = '<li>None</li>';
    document.getElementById('pdf-assets').innerHTML = assetsHTML;

    const element = document.getElementById('pdf-dossier');
    element.classList.remove('hidden');

    const opt = {
     margin:       0.5,
     filename:     `DOSSIER_${c.name.replace(' ','_').toUpperCase()}.pdf`,
     image:        { type: 'jpeg', quality: 0.98 },
     html2canvas:  { scale: 2, useCORS: true },
     jsPDF:        { unit: 'in', format: 'letter', orientation: 'portrait' }
    };

    html2pdf().from(element).set(opt).save().then(() => {
     element.classList.add('hidden');
    });
   },

   closeAllModals() {
    ['char-modal', 'vehicle-modal', 'property-modal', 'equipment-modal'].forEach(id => {
     const el = document.getElementById(id);
     if(el) {
      el.classList.add('hidden');
      el.classList.add('opacity-0');
     }
    });
    currentOpenedChar = null;
   },

   closeModal(id) { 
    const modal = document.getElementById(id);
    if(!modal) return;
    modal.classList.add('opacity-0');
    setTimeout(() => modal.classList.add('hidden'), 300);
    if(id === 'char-modal') currentOpenedChar = null;
   },

   decryptModal() {
    const screen = document.getElementById('char-decrypt-screen');
    if(screen) screen.classList.add('hidden');
    SFX.decrypt();
   },

   openModal(id) {
    this.closeAllModals(); 
    const dict = i18n[currentLang];
    const c = DB.characters.find(x => x.id === id);
    if(!c) return;
    
    currentOpenedChar = c; 
    const org = this.getOrg(c.organization);
    
    const decryptScreen = document.getElementById('char-decrypt-screen');
    if (c.isClassified) {
     if(decryptScreen) decryptScreen.classList.remove('hidden');
    } else {
     if(decryptScreen) decryptScreen.classList.add('hidden');
     SFX.decrypt(); 
    }

    if (c.threatLevel === 'Omega' || c.heatLevel === 'Most Wanted') {
     SFX.warning();
    }

    const mImg = document.getElementById('modal-img');
    if(mImg) mImg.src = c.image || `https://ui-avatars.com/api/?name=${c.name}&background=000&color=fff&size=512`;
    
    const statEl = document.getElementById('modal-status');
    if(statEl) {
     const translatedStatus = dict[c.status.toLowerCase()] || c.status;
     statEl.innerText = `${dict.status}: ${translatedStatus}`;
     statEl.className = `font-mono text-[10px] mb-1 font-bold tracking-widest px-2 py-1 inline-block bg-black/80 border ${c.status === 'Deceased' ? 'text-cyber-red border-cyber-red' : 'text-cyber-green border-cyber-green'}`;
    }
    
    const heatEl = document.getElementById('modal-heat');
    if(heatEl) {
     const heatClass = `heat-${c.heatLevel.replace(' ', '_')}`;
     const translatedHeat = dict[c.heatLevel.toLowerCase().replace(' ', '_')] || c.heatLevel;
     heatEl.innerHTML = `<i class="fas fa-star mr-1 text-cyber-gold"></i> ${dict.heat}: ${translatedHeat}`;
     heatEl.className = `font-mono text-[10px] mb-1 font-bold tracking-widest px-2 py-1 inline-block bg-black/80 border border-gray-700 ${heatClass}`;
    }

    const threatEl = document.getElementById('modal-threat');
    if(threatEl) {
     const translatedThreat = dict[c.threatLevel.toLowerCase()] || c.threatLevel;
     threatEl.innerText = `${dict.threat}: ${translatedThreat}`;
     const threatClass = c.threatLevel === 'Omega' ? 'threat-Omega' : `threat-${c.threatLevel}`;
     threatEl.className = `font-display font-black uppercase tracking-widest text-2xl mt-1 ${threatClass}`;
    }
    
    const mNameMain = document.getElementById('modal-name-main');
    if(mNameMain) {
     mNameMain.innerText = c.name;
    const _mci = document.getElementById('modal-char-id');
    if(_mci) _mci.value = id;
     mNameMain.setAttribute('data-text', c.name);
    }
    const mAliasSub = document.getElementById('modal-alias-sub');
    if(mAliasSub) mAliasSub.innerText = c.alias ? `"${c.alias}"` : "";
    
    const mOrg = document.getElementById('modal-org');
    if(mOrg) {
     mOrg.innerText = org.name;
     mOrg.style.color = org.color;
    }
    
    const mId = document.getElementById('modal-id');
    if(mId) mId.innerText = (c.id || "").toUpperCase();
    const mStory = document.getElementById('modal-story');
    if(mStory) mStory.innerText = c.story || 'No historical data available.';

    // Theme Song - char-modal için
    const mSongEl = document.getElementById('modal-theme-song-player');
    if(mSongEl) {
      if(c.themeSong) {
        UI._renderThemeSong(mSongEl, c.themeSong);
      } else {
        mSongEl.innerHTML = '';
      }
    }

    const relContainer = document.getElementById('modal-rel-container');
    if (c.relationships && c.relationships.length > 0) {
     if(relContainer) relContainer.classList.remove('hidden');
     const mRel = document.getElementById('modal-relationships');
     if(mRel) {
      mRel.innerHTML = c.relationships.map(r => {
       const targetChar = DB.characters.find(x => x.id === r.targetId);
       if (!targetChar) return '';
       const targetName = targetChar.isClassified ? '[ REDACTED ]' : targetChar.name;
       return `
       <div onclick="UI.openModal('${r.targetId}')" class="bg-black/40 p-3 border border-gray-800 hover:border-cyber-gold hover:bg-cyber-gold/10 cursor-pointer transition-all flex justify-between items-center group click-sfx hover-sfx">
        <div class="flex flex-col">
         <span class="text-cyber-gold font-bold text-sm group-hover:text-white transition-colors">${targetName}</span>
         <span class="text-gray-500 text-[10px] tracking-widest uppercase">${r.type}</span>
        </div>
        <i class="fas fa-chevron-right text-gray-700 group-hover:text-cyber-gold transition-colors"></i>
       </div>`;
      }).join('');
     }
    } else {
     if(relContainer) relContainer.classList.add('hidden');
    }

    

    const _snBar = document.getElementById('modal-status-note-bar');
    const _snTxt = document.getElementById('modal-status-note-text');
    if(_snBar && _snTxt) {
     if(c.statusNote) {
      _snTxt.textContent = c.statusNote;
      _snBar.style.display = 'flex';
      const _snOrg = DB.organizations.find(o=>(c.organizations||[c.organization||'']).includes(o.id));
      if(_snOrg){_snBar.style.borderLeftColor=_snOrg.color;_snBar.style.background=_snOrg.color+'15';_snBar.style.color=_snOrg.color;}
     } else { _snBar.style.display='none'; }
    }
    

    

    const _bankCont = document.getElementById('modal-bank-container');
    const _bankList = document.getElementById('modal-bank-list');
    if(_bankCont && _bankList) {
     const accounts = c.bankAccounts||[];
     _bankCont.style.display = accounts.length > 0 ? 'block' : 'none';
     _bankList.innerHTML = accounts.map(acc=>`
      <div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800 font-mono text-xs">
       <i class="fas fa-landmark text-cyber-blue w-4 text-center"></i>
       <div class="flex-1">
        <span class="text-white font-bold">${acc.bank||'—'}</span>
        <span class="text-gray-500 ml-2">${acc.account||''}</span>
       </div>
       ${acc.balance ? `<span class="text-cyber-green border border-cyber-green/30 px-1.5 py-0.5">${acc.balance}</span>` : ''}
      </div>
      ${acc.note ? `<div class="font-mono text-[10px] text-gray-500 italic pl-7 -mt-1 pb-1">${acc.note}</div>` : ''}`
     ).join('');
    }
    const _repCont = document.getElementById('modal-rep-container');
    const _repCont2 = document.getElementById('modal-rep-content');
    if(_repCont2) {
     const rep=c.reputation||{global:0,level:'Unknown',orgs:{},notes:''};
     const _rC={Unknown:'#6b7280',Street:'#9ca3af',Known:'#60a5fa',Notorious:'#f59e0b',Legendary:'#f97316',Mythic:'#a855f7'};
     const _rI={Unknown:'fa-question-circle',Street:'fa-circle',Known:'fa-eye',Notorious:'fa-skull',Legendary:'fa-fire',Mythic:'fa-crown'};
     const gv=rep.global||0, gp=((gv+100)/200)*100;
     const gc=gv>=75?'#a855f7':gv>=40?'#f97316':gv>=10?'#60a5fa':gv<=-40?'#ff2a2a':gv<=-10?'#facc15':'#6b7280';
     const lc=_rC[rep.level]||'#6b7280', li=_rI[rep.level]||'fa-question-circle';
     const orgR=Object.entries(rep.orgs||{}).map(([oid,sc])=>{const o2=DB.organizations.find(x=>x.id===oid);if(!o2)return'';const sp=((sc+100)/200)*100;const sco=sc>=50?'#22c55e':sc>=10?'#60a5fa':sc<=-50?'#ff2a2a':sc<=-10?'#facc15':'#6b7280';return `<div class="rep-org-row mb-2"><span class="w-28 truncate" style="color:${o2.color}">${o2.name}</span><div class="rep-bar-track"><div class="rep-bar-fill" style="width:${sp}%;background:${sco}"></div></div><span class="rep-score-badge" style="color:${sco}">${sc>0?'+':''}${sc}</span></div>`;}).join('');
     const hasRep=true; 

     if(_repCont) _repCont.style.display='block';
     _repCont2.innerHTML=hasRep?`<div class="flex items-center gap-4 mb-3"><div class="text-center"><div class="font-display font-black text-2xl" style="color:${lc}"><i class="fas ${li} mr-1"></i>${rep.level}</div><div class="font-mono text-[10px] text-gray-500 mt-1">REPUTATION</div></div><div class="flex-1"><div class="flex justify-between font-mono text-[10px] text-gray-500 mb-1"><span>GLOBAL</span><span style="color:${gc}" class="font-bold">${gv>0?'+':''}${gv}</span></div><div class="rep-bar-track h-2"><div class="rep-bar-fill" style="width:${gp}%;background:${gc}"></div></div></div></div>${orgR?`<div class="mb-2">${orgR}</div>`:''}${rep.notes?`<p class="font-mono text-xs text-gray-400 italic border-l-2 border-gray-700 pl-3 mt-2">${rep.notes}</p>`:''}`:'';
    }
    const vehs = DB.vehicles.filter(v => v.owner === c.id);
    const props = DB.properties.filter(p => p.owner === c.id);
    const eqs = DB.equipments.filter(e => e.owner === c.id);

    const mVeh = document.getElementById('modal-vehicles');
    if(mVeh) {
     mVeh.innerHTML = vehs.length 
      ? vehs.map(v => `
       <div onclick="UI.openVehicleModal('${v.id}')" class="bg-black/40 p-3 border border-gray-800 hover:border-cyber-blue hover:bg-cyber-blue/10 cursor-pointer transition-all flex justify-between items-center group click-sfx hover-sfx">
        <div class="flex flex-col">
         <span class="text-cyber-blue font-bold text-sm group-hover:text-white transition-colors">${v.model}</span>
         <span class="text-gray-500 text-[10px] tracking-widest">${v.plate||dict.none}</span>
        </div>
        <i class="fas fa-chevron-right text-gray-700 group-hover:text-cyber-blue transition-colors"></i>
       </div>`).join('') 
      : `<div class="text-gray-700 italic text-xs">${dict.no_vehicles}</div>`;
    }

    const mProp = document.getElementById('modal-properties');
    if(mProp) {
     mProp.innerHTML = props.length 
      ? props.map(p => `
       <div onclick="UI.openPropertyModal('${p.id}')" class="bg-black/40 p-3 border border-gray-800 hover:border-cyber-purple hover:bg-cyber-purple/10 cursor-pointer transition-all flex justify-between items-center group click-sfx hover-sfx">
        <div class="flex flex-col">
         <span class="text-cyber-purple font-bold text-sm group-hover:text-white transition-colors">${p.name}</span>
         <span class="text-gray-500 text-[10px] tracking-widest">${p.type}</span>
        </div>
        <i class="fas fa-chevron-right text-gray-700 group-hover:text-cyber-purple transition-colors"></i>
       </div>`).join('') 
      : `<div class="text-gray-700 italic text-xs">${dict.no_assets}</div>`;
    }

    const mEq = document.getElementById('modal-equipments');
    if(mEq) {
     mEq.innerHTML = eqs.length 
      ? eqs.map(e => `
       <div onclick="UI.openEquipmentModal('${e.id}')" class="bg-black/40 p-3 border border-gray-800 hover:border-cyber-omega hover:bg-cyber-omega/10 cursor-pointer transition-all flex justify-between items-center group click-sfx hover-sfx">
        <div class="flex flex-col">
         <span class="text-cyber-omega font-bold text-sm group-hover:text-white transition-colors">${e.name}</span>
         <span class="text-gray-500 text-[10px] tracking-widest uppercase">${e.type}</span>
        </div>
        <i class="fas fa-chevron-right text-gray-700 group-hover:text-cyber-omega transition-colors"></i>
       </div>`).join('') 
      : `<div class="text-gray-700 italic text-xs">${dict.no_equipments || 'No registered gear.'}</div>`;
    }

    const linkBtn = document.getElementById('modal-link');
    if(linkBtn) {
     if(c.link && c.link.trim() !== '') {
      linkBtn.href = c.link;
      linkBtn.classList.remove('hidden');
     } else {
      linkBtn.classList.add('hidden');
     }
    }

    const modal = document.getElementById('char-modal');
    if(modal) {
     modal.classList.remove('hidden');
     setTimeout(() => modal.classList.remove('opacity-0'), 10);
    }
   },

   openVehicleModal(id) {
    this.closeAllModals(); 
    SFX.decrypt();
    const dict = i18n[currentLang];
    const v = DB.vehicles.find(x => x.id === id);
    if(!v) return;

    if (v.heatLevel === 'Most Wanted') SFX.warning();

    const vImg = document.getElementById('v-modal-img'); if(vImg) vImg.src = v.image || 'https://via.placeholder.com/600x300/0a0a0c/00a2ff?text=NO+VISUAL+DATA';
    const vModel = document.getElementById('v-modal-model');
    if(vModel) {
     vModel.innerText = v.model;
     vModel.setAttribute('data-text', v.model);
    }
    const vPlate = document.getElementById('v-modal-plate'); if(vPlate) vPlate.innerText = v.plate || dict.unregistered;
    const vPerf = document.getElementById('v-modal-perf'); if(vPerf) vPerf.innerText = v.perf || '';
    // Specs grid
    const _sg = document.getElementById('v-modal-specs-grid');
    if(_sg) {
     const _rows = [
      v.brand && v.model ? ['<i class="fas fa-car mr-1"></i>ARAÇ', `${v.brand} ${v.model}`] : null,
      v.year            ? ['ÜRETİM', v.year] : null,
      v.color           ? ['RENK', v.color] : null,
      v.hp              ? ['GÜÇ', `${v.hp} HP`] : null,
      v.acc             ? ['0-100', `${v.acc} sn`] : null,
      (v.topspeed||v.topSpeed) ? ['MAKS HIZ',
        `${v.topspeed||v.topSpeed} km/h${v.topspeedMph?' / '+v.topspeedMph+' mph':''}`] : null,
      v.price           ? ['FİYAT', v.price] : null,
      v.plate           ? ['PLAKA', v.plate] : null,
     ].filter(Boolean);
     _sg.innerHTML = _rows.map(([k,val])=>
      `<div class="flex justify-between gap-2">
        <span class="text-gray-600 text-[10px] tracking-widest flex-shrink-0">${k}</span>
        <span class="text-white text-right">${val}</span>
       </div>`
     ).join('');
    }

    const heatEl = document.getElementById('v-modal-heat');
    if(heatEl) {
     const heatClass = `heat-${v.heatLevel.replace(' ', '_')}`;
     const translatedHeat = dict[v.heatLevel.toLowerCase().replace(' ', '_')] || v.heatLevel;
     heatEl.innerHTML = `<i class="fas fa-star mr-1 text-cyber-gold"></i> ${dict.heat}: ${translatedHeat}`;
     heatEl.className = `absolute top-0 right-0 text-xs font-bold tracking-widest px-2 py-1 bg-black/80 border border-gray-700 ${heatClass}`;
    }

    const owner = DB.characters.find(c => c.id === v.owner);
    const ownerDiv = document.getElementById('v-modal-owner');
    if(ownerDiv) {
     if(owner) {
      const ownerName = owner.isClassified ? '[ REDACTED ]' : owner.name;
      ownerDiv.innerHTML = `<button type="button" onclick="UI.openModal('${owner.id}')" class="text-cyber-green hover:text-white hover:underline transition-colors font-bold uppercase tracking-widest flex items-center gap-2 click-sfx hover-sfx"><i class="fas fa-user-circle"></i> ${ownerName}</button>`;
     } else {
      ownerDiv.innerHTML = `<span class="text-gray-600 font-bold uppercase tracking-widest">${dict.unregistered}</span>`;
     }
    }

    const linkBtn = document.getElementById('v-modal-link');
    if(linkBtn) {
     if(v.link && v.link.trim() !== '') {
      linkBtn.href = v.link;
      linkBtn.classList.remove('hidden');
     } else {
      linkBtn.classList.add('hidden');
     }
    }

    const modal = document.getElementById('vehicle-modal');
    if(modal) {
     modal.classList.remove('hidden');
     setTimeout(() => modal.classList.remove('opacity-0'), 10);
    }
   },

   openPropertyModal(id) {
    this.closeAllModals(); 
    SFX.decrypt();
    const dict = i18n[currentLang];
    const p = DB.properties.find(x => x.id === id);
    if(!p) return;

    const pImg = document.getElementById('p-modal-img'); if(pImg) pImg.src = p.image || 'https://via.placeholder.com/600x400/0a0a0c/b026ff?text=NO+VISUAL+DATA';
    const pName = document.getElementById('p-modal-name');
    if(pName) {
     pName.innerText = p.name;
     pName.setAttribute('data-text', p.name);
    }
    const pLoc = document.getElementById('p-modal-loc'); if(pLoc) pLoc.innerText = p.location || dict.none;
    const pType = document.getElementById('p-modal-type'); if(pType) pType.innerText = p.type || dict.classified;
    const pDesc = document.getElementById('p-modal-desc'); if(pDesc) pDesc.innerText = p.desc || '';

    const owner = DB.characters.find(c => c.id === p.owner);
    const ownerDiv = document.getElementById('p-modal-owner');
    if(ownerDiv) {
     if(owner) {
      const ownerName = owner.isClassified ? '[ REDACTED ]' : owner.name;
      ownerDiv.innerHTML = `<button type="button" onclick="UI.openModal('${owner.id}')" class="text-cyber-green hover:text-white hover:underline transition-colors font-bold uppercase tracking-widest flex items-center gap-2 click-sfx hover-sfx"><i class="fas fa-user-circle"></i> ${ownerName}</button>`;
     } else {
      ownerDiv.innerHTML = `<span class="text-gray-600 font-bold uppercase tracking-widest">${dict.classified}</span>`;
     }
    }

    const linkBtn = document.getElementById('p-modal-link');
    if(linkBtn) {
     if(p.link && p.link.trim() !== '') {
      linkBtn.href = p.link;
      linkBtn.classList.remove('hidden');
     } else {
      linkBtn.classList.add('hidden');
     }
    }

    const modal = document.getElementById('property-modal');
    if(modal) {
     modal.classList.remove('hidden');
     setTimeout(() => modal.classList.remove('opacity-0'), 10);
    }
   },

   openEquipmentModal(id) {
    this.closeAllModals(); 
    SFX.decrypt();
    const dict = i18n[currentLang];
    const e = DB.equipments.find(x => x.id === id);
    if(!e) return;

    const eImg = document.getElementById('eq-modal-img'); if(eImg) eImg.src = e.image || 'https://via.placeholder.com/600x400/0a0a0c/ff0055?text=NO+VISUAL+DATA';
    const eName = document.getElementById('eq-modal-name');
    if(eName) {
     eName.innerText = e.name;
     eName.setAttribute('data-text', e.name);
    }
    const eType = document.getElementById('eq-modal-type'); if(eType) eType.innerText = e.type || dict.classified;
    const eDesc = document.getElementById('eq-modal-desc'); if(eDesc) eDesc.innerText = e.desc || '';

    const owner = DB.characters.find(c => c.id === e.owner);
    const ownerDiv = document.getElementById('eq-modal-owner');
    if(ownerDiv) {
     if(owner) {
      const ownerName = owner.isClassified ? '[ REDACTED ]' : owner.name;
      ownerDiv.innerHTML = `<button type="button" onclick="UI.openModal('${owner.id}')" class="text-cyber-green hover:text-white hover:underline transition-colors font-bold uppercase tracking-widest flex items-center gap-2 click-sfx hover-sfx"><i class="fas fa-user-circle"></i> ${ownerName}</button>`;
     } else {
      ownerDiv.innerHTML = `<span class="text-gray-600 font-bold uppercase tracking-widest">${dict.unregistered}</span>`;
     }
    }

    const linkBtn = document.getElementById('eq-modal-link');
    if(linkBtn) {
     if(e.link && e.link.trim() !== '') {
      linkBtn.href = e.link;
      linkBtn.classList.remove('hidden');
     } else {
      linkBtn.classList.add('hidden');
     }
    }

    const modal = document.getElementById('equipment-modal');
    if(modal) {
     modal.classList.remove('hidden');
     setTimeout(() => modal.classList.remove('opacity-0'), 10);
    }
   },

   promptAdmin() { 
    const loginModal = document.getElementById('admin-login-modal');
    if(!loginModal) return;
    window._selectedPlayer = window.currentPlayer || null;
    renderPlayerSelectGrid();
    loginModal.classList.remove('hidden');
   }
  };

var Admin = {
   exportDB() { Storage.export(DB); },
   login() {
    const p = window._selectedPlayer;
    if(!p) return;
    window.currentPlayer   = p;
    window.currentOperator = p.name;
    localStorage.setItem(CFG.playerKey, JSON.stringify(p));
    const loginModal = document.getElementById('admin-login-modal');
    if(loginModal) loginModal.classList.add('hidden');
    updatePlayerIndicator();
    // Admin paneli aç
    UI.switchTab('admin');
    
    

    const unameEl = document.getElementById('admin-username');
    const uname = (unameEl?.value?.trim()) || 'UNKNOWN';
    window.currentOperator = uname;
    if(unameEl) unameEl.value = '';
    

    this.addAuditLog('login', `Operator [${uname}] accessed Admin Panel`, null, uname);
    Tabs.open('admin');
    UI._switchViewOnly('admin');
    this.switchTab('chars');
   },
   switchTab(tab) {
    document.querySelectorAll('.admin-panel').forEach(e => {
     e.classList.add('hidden');
     e.style.display = 'none';
    });
    document.querySelectorAll('.admin-tab').forEach(e => { 
     e.classList.remove('border-cyber-blue','text-cyber-blue', 'bg-cyber-blue/5', 'border-cyber-red', 'text-cyber-red', 'bg-cyber-red/10', 'border-cyber-gold', 'text-cyber-gold', 'bg-cyber-gold/10', 'border-cyber-omega', 'text-cyber-omega', 'bg-cyber-omega/10'); 
     e.classList.add('border-transparent','text-gray-500'); 
    });
    
    const panel = document.getElementById(`admin-${tab}`);
    if(panel) { panel.classList.remove('hidden'); panel.style.display = 'block'; }
    

    const btn = document.querySelector('.admin-tab[data-target="admin-' + tab + '"]');
    if(btn) {
     if(tab === 'contracts') btn.classList.add('border-cyber-red','text-cyber-red', 'bg-cyber-red/10');
     else if(tab === 'cases') btn.classList.add('border-cyber-gold','text-cyber-gold', 'bg-cyber-gold/10');
     else if(tab === 'equipments') btn.classList.add('border-cyber-omega','text-cyber-omega', 'bg-cyber-omega/10');
     else if(tab === 'audit') btn.classList.add('border-cyber-gold','text-cyber-gold', 'bg-cyber-gold/10');
     else if(tab === 'logs') btn.classList.add('border-cyber-green','text-cyber-green', 'bg-cyber-green/5');
     else btn.classList.add('border-cyber-blue','text-cyber-blue', 'bg-cyber-blue/5');
     btn.classList.remove('border-transparent','text-gray-500');
    }

    if(tab === 'chars') this.loadChars();
    if(tab === 'orgs') this.loadOrgs();
    if(tab === 'vehicles') this.loadVehicles();
    if(tab === 'properties') this.loadProperties();
    if(tab === 'equipments') this.loadEquipments();
    if(tab === 'contracts') this.loadContracts();
    if(tab === 'cases') this.loadCases();
    if(tab === 'logs') { this.loadLogs(); this.loadEvents(); }
    try{UI.updateMobileTab(tab);}catch(e){}
    if(tab === 'audit') this.refreshAuditPanel();
    if(tab === 'backup') this.loadBackups();
    if(tab === 'events') this.loadEvents();
   },
   loadChars() {
    const pSel = document.getElementById('c-player');
    if(pSel) {
     pSel.innerHTML = '<option value="">— NPC / Atanmamış —</option>' +
      (window.NYC_PLAYERS||[]).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
    }
    const pSel2=document.getElementById('c-player');
    if(pSel2)pSel2.innerHTML='<option value="">— NPC —</option>'+(window.NYC_PLAYERS||[]).map(p=>`<option value="${p.id}">${p.name}</option>`).join('');
    

    const cOrgSel = document.getElementById('c-org-select');
    if(cOrgSel) cOrgSel.innerHTML = '<option value="">Select Organization...</option>' + DB.organizations.map(o => `<option value="${o.id}">${o.name}</option>`).join('');

    

    const repOrgGrid = document.getElementById('c-rep-org-grid');
    if(repOrgGrid) {
     repOrgGrid.innerHTML = DB.organizations.map(o => `
      <div class="flex items-center gap-2 bg-black/40 border border-gray-800 px-2 py-1.5">
       <span class="font-mono text-[9px] truncate flex-1" style="color:${o.color}">${o.name}</span>
       <input type="number" min="-100" max="100" step="1" value=""
        class="c-rep-org-input w-16 text-right font-mono text-xs bg-transparent border-b border-gray-700 focus:border-cyber-blue outline-none text-white"
        data-orgid="${o.id}" placeholder="—"
        title="${o.name} itibarı (-100/+100)">
      </div>`).join('');
    }
    const rTar = document.getElementById('r-target'); if(rTar) rTar.innerHTML = `<option value="">Select Target...</option>` + getSortedChars().map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    
    

    const bulkBar = document.getElementById('bulk-ops-bar');
    if(bulkBar) bulkBar.innerHTML = `
     <div class="flex items-center gap-2 mb-2 flex-wrap">
      <label class="flex items-center gap-1 cursor-pointer hover-sfx text-[10px] font-mono text-gray-400">
       <input type="checkbox" id="bulk-select-all" onchange="Admin.bulkSelectAll(this)" class="cyber-checkbox">TÜMÜNü SEÇ
      </label>
      <div id="bulk-action-btns" class="hidden flex gap-2">
       <select id="bulk-org-target" class="text-[10px] bg-black border border-gray-700 text-gray-300 px-2 py-1">
        <option value="">Org ata...</option>
        ${DB.organizations.map(o=>`<option value="${o.id}">${o.name}</option>`).join('')}
       </select>
       <button onclick="Admin.bulkAssignOrg()" class="cyber-button px-3 py-1 text-[10px] click-sfx hover-sfx">ORG ATA</button>
       <button onclick="Admin.bulkDelete()" class="cyber-button danger px-3 py-1 text-[10px] click-sfx hover-sfx">TOPLU SİL</button>
      </div>
     </div>`;
    const list = document.getElementById('admin-list-chars');
    if(list) {
     list.innerHTML = getSortedChars().map(c => {
      const orgs = c.organizations || (c.organization ? [c.organization] : []);
      const orgNames = orgs.map(oid => { const o = DB.organizations.find(x=>x.id===oid); return o ? o.name : ''; }).filter(Boolean).join(', ') || 'Unaffiliated';
      return `
      <div class="flex items-center gap-2 p-3 bg-black/40 hover:bg-cyber-blue/10 border border-gray-800 transition-colors group">
       <input type="checkbox" class="cyber-checkbox bulk-char-cb flex-shrink-0" data-charid="${c.id}" onchange="Admin.onBulkChange()" onclick="event.stopPropagation()">
       <div class="flex-1 flex justify-between items-center cursor-pointer hover-sfx click-sfx" onclick="Admin.editChar('${c.id}')">
        <span class="text-white">${c.name} <span class="text-gray-500 ml-2">[${c.status}]</span> <span class="text-gray-600 text-[10px] ml-1">${orgNames}</span> ${c.isClassified ? '<i class="fas fa-lock text-cyber-red ml-2"></i>' : ''}</span>
        <i class="fas fa-edit text-cyber-blue opacity-0 group-hover:opacity-100"></i>
       </div>
      </div>`;
     }).join('');
    }
   },
   editChar(id) {
    const c = DB.characters.find(x => x.id === id);
    if(!c) return;
    document.getElementById('c-id').value = c.id; 
    document.getElementById('c-name').value = c.name;
    document.getElementById('c-alias').value = c.alias || '';
    document.getElementById('c-status').value = c.status || 'Active'; 
    document.getElementById('c-threat').value = c.threatLevel || 'Medium';
    document.getElementById('c-heat').value = c.heatLevel || 'Clean'; 
    document.getElementById('c-classified').checked = c.isClassified || false;
    if(document.getElementById('c-locked'))    document.getElementById('c-locked').checked    = c.isLocked    || false;
    if(document.getElementById('c-archived'))  document.getElementById('c-archived').checked  = c.isArchived  || false;
    if(document.getElementById('c-profile-type')) document.getElementById('c-profile-type').value = c.profileType || 'main';
    if(document.getElementById('c-theme-song'))   document.getElementById('c-theme-song').value   = c.themeSong   || '';
    document.getElementById('c-mapx').value = c.mapX || ''; 
    document.getElementById('c-mapy').value = c.mapY || '';
    document.getElementById('c-img').value = c.image || ''; 
    document.getElementById('c-link').value = c.link || ''; 
    document.getElementById('c-story').value = c.story || '';
    const csNote = document.getElementById('c-status-note');
    if(csNote) csNote.value = c.statusNote || '';
    const _cpSel = document.getElementById('c-player');
    if(_cpSel) _cpSel.value = c.playerId || '';
    
    

    const orgList = document.getElementById('c-org-list');
    if(orgList) {
     orgList.innerHTML = '';
     const orgs = c.organizations || (c.organization ? [c.organization] : []);
     orgs.forEach(oid => this.addCharOrgUI(oid));
    }
    
    const relList = document.getElementById('c-rel-list'); if(relList) relList.innerHTML = '';
    if(c.relationships) c.relationships.forEach(r => this.addRelUI(r.targetId, r.type));
    document.getElementById('c-btn-del').classList.remove('hidden');

    

    const bankList = document.getElementById('c-bank-list');
    if(bankList) {
     bankList.innerHTML = '';
     (c.bankAccounts||[]).forEach(acc => Admin.addBankAccountUI(acc));
    }

     

    const _cpSel2=document.getElementById('c-player');
                if(_cpSel2&&window.NYC_PLAYERS){_cpSel2.innerHTML='<option value="">— NPC —</option>'+window.NYC_PLAYERS.map(p=>`<option value="${p.id}">${p.name}</option>`).join('');_cpSel2.value=c.playerId||'';}
                const editBankList = document.getElementById('c-bank-list');
    if(editBankList) { editBankList.innerHTML=''; (c.bankAccounts||[]).forEach(acc=>Admin.addBankAccountUI(acc)); }

  

    const rep = c.reputation || { global: 0, level: 'Unknown', orgs: {}, notes: '' };
    const repGlobal = document.getElementById('c-rep-global');
    if(repGlobal) repGlobal.value = rep.global || 0;
    const repLevel = document.getElementById('c-rep-level');
    if(repLevel) repLevel.value = rep.level || 'Unknown';
    const repNotes = document.getElementById('c-rep-notes');
    if(repNotes) repNotes.value = rep.notes || '';
    

    document.querySelectorAll('.c-rep-org-input').forEach(el => {
     if(el.dataset.orgid) {
      el.value = rep.orgs?.[el.dataset.orgid] ?? '';
     }
    });
    

    const repSlider = document.getElementById('c-rep-global');
    if(repSlider) Admin.updateRepSlider(repSlider);

    

    document.getElementById('char-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
   },

   addCharOrg() {
    const sel = document.getElementById('c-org-select');
    const val = sel ? sel.value : '';
    if(!val) return;
    const existing = Array.from(document.querySelectorAll('#c-org-list .char-org-item')).map(el => el.dataset.orgid);
    if(existing.includes(val)) return;
    this.addCharOrgUI(val);
    if(sel) sel.value = '';
   },

   addCharOrgUI(orgId) {
    const org = DB.organizations.find(o => o.id === orgId);
    if(!org) return;
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 px-2 py-1 border char-org-item';
    div.dataset.orgid = orgId;
    div.style.borderColor = org.color + '60';
    div.innerHTML = `<span class="font-mono text-xs font-bold" style="color:${org.color}">${org.name}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    document.getElementById('c-org-list').appendChild(div);
   },
   addRel() {
    const target = document.getElementById('r-target').value;
    const type = document.getElementById('r-type').value;
    if(!target || !type) return alert("Select target and write type.");
    this.addRelUI(target, type);
    document.getElementById('r-target').value = ''; document.getElementById('r-type').value = '';
   },
   addRelUI(targetId, type) {
    const targetChar = DB.characters.find(c => c.id === targetId);
    if(!targetChar) return;
    const div = document.createElement('div');
    div.className = "flex justify-between items-center bg-gray-900 border border-gray-700 p-2 rel-item";
    div.dataset.target = targetId; div.dataset.type = type;
    div.innerHTML = `<span><span class="text-cyber-gold">${targetChar.name}</span> - <span class="text-gray-400">${type}</span></span><button type="button" class="text-cyber-red hover:text-white click-sfx hover-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>`;
    document.getElementById('c-rel-list').appendChild(div);
   },
   saveCharacter(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('c-id').value || `char_${Date.now()}`;
    const relEls = document.querySelectorAll('#c-rel-list .rel-item');
    const relationships = Array.from(relEls).map(el => ({ targetId: el.dataset.target, type: el.dataset.type }));

    

    const orgEls = document.querySelectorAll('#c-org-list .char-org-item');
    const organizations = Array.from(orgEls).map(el => el.dataset.orgid);
    

    const organization = organizations[0] || '';

    const existing = DB.characters.find(x => x.id === id);
    const data = {
     ...(existing || {}),
     id, 
     name: document.getElementById('c-name').value, 
     alias: document.getElementById('c-alias').value,
     organization: organization,         

     organizations: organizations,       

     status: document.getElementById('c-status').value,
     threatLevel: document.getElementById('c-threat').value, 
     heatLevel: document.getElementById('c-heat').value, 
     isClassified: document.getElementById('c-classified').checked,
     isLocked:    document.getElementById('c-locked')?.checked || false,
     isArchived:  document.getElementById('c-archived')?.checked || false,
     profileType: document.getElementById('c-profile-type')?.value || 'main',
     themeSong:   document.getElementById('c-theme-song')?.value?.trim() || '',
     mapX: document.getElementById('c-mapx').value || null, 
     mapY: document.getElementById('c-mapy').value || null,
     image: document.getElementById('c-img').value, 
     link: document.getElementById('c-link').value, 
     story: document.getElementById('c-story').value,
     playerId:   document.getElementById('c-player')?.value || '',
     statusNote: document.getElementById('c-status-note')?.value?.trim() || '',
     relationships: relationships,
     player: (document.getElementById('c-player')||{}).value||'',
                    bankAccounts: Array.from(document.querySelectorAll('#c-bank-list .bank-item')).map(el=>({
      bank:el.dataset.bank||'',account:el.dataset.account||'',balance:el.dataset.balance||'',note:el.dataset.note||''
     })),
     bankAccounts: Array.from(document.querySelectorAll('#c-bank-list .bank-item')).map(el=>({
      bank: el.dataset.bank||'',
      account: el.dataset.account||'',
      balance: el.dataset.balance||'',
      note: el.dataset.note||''
     })),
     reputation: (() => {
      const globalScore = parseInt(document.getElementById('c-rep-global')?.value || '0');
      const level = document.getElementById('c-rep-level')?.value || 'Unknown';
      const notes = document.getElementById('c-rep-notes')?.value || '';
      const orgs = {};
      document.querySelectorAll('.c-rep-org-input').forEach(el => {
       if(el.dataset.orgid && el.value !== '') {
        orgs[el.dataset.orgid] = parseInt(el.value) || 0;
       }
      });
      return { global: globalScore, level, orgs, notes };
     })()
    };
    

    const isNew = !DB.characters.find(x => x.id === id);
    const dbIdx = DB.characters.findIndex(x => x.id === id);
    if(dbIdx >= 0) DB.characters[dbIdx] = data; else DB.characters.push(data);
    const cname = data.name || 'karakter';
    this.finalizeSave(this.loadChars.bind(this), 'char',
     isNew ? `Yeni karakter oluşturuldu: ${cname}` : `Karakter güncellendi: ${cname}`,
     isNew ? 'create' : 'edit', id);

   },

   loadOrgs() {
    const list = document.getElementById('admin-list-orgs');
    if(list) {
     list.innerHTML = DB.organizations.map(o => `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-cyber-blue/10 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editOrg('${o.id}')">
       <span class="text-white">${o.name}</span>
       <i class="fas fa-edit text-cyber-blue"></i>
      </div>`).join('');
    }
   },
   editOrg(id) {
    const o = DB.organizations.find(x => x.id === id);
    if(!o) return;
    document.getElementById('o-id').value = o.id;
    const _omDiv = document.getElementById('admin-org-members');
    if(_omDiv) _omDiv.style.display = 'block'; 
    document.getElementById('o-name').value = o.name;
    document.getElementById('o-color').value=o.color||'#00a2ff';
 const _ot=document.getElementById('o-threat'); if(_ot) _ot.value=o.threatLevel||'Low';
     // Üyeleri DB.characters'dan çek (bu org'a kayıtlı olanlar)
     // Org üyeleri: DB.characters'dan bu org'a kayıtlı olanları getir
     const _orgId = o.id;
     const _orgMembers = DB.characters.filter(c=>(c.organizations||[c.organization]).includes(_orgId));
     // Rol verisi o.memberRoles'dan gelir: {charId: role}
     const _mRoles = o.memberRoles || {};
     // editOrg'da admin-org-members bölümünü doldur
     const _omList = document.getElementById('admin-org-members');
     if(_omList) {
      if(_orgMembers.length === 0) {
       _omList.innerHTML = `<p class="font-mono text-[10px] text-gray-600 text-center py-4">Bu organizasyonda henüz üye yok.<br><span class="text-[9px]">Karakterin org listesine bu org'u ekleyin.</span></p>`;
      } else {
       _omList.innerHTML = _orgMembers.map(c => {
        const img = c.image||`https://ui-avatars.com/api/?name=${encodeURIComponent(c.name)}&background=000&color=fff&size=32`;
        const role = _mRoles[c.id] || '';
        const pl = (window.NYC_PLAYERS||[]).find(p=>p.id===c.playerId);
        return `<div class="flex items-center gap-3 p-2 bg-black/40 border border-gray-800 mb-1" data-charid="${c.id}">
         <img src="${img}" class="w-8 h-8 rounded-full object-cover flex-shrink-0">
         <div class="flex-1 min-w-0">
          <div class="font-mono text-xs text-white leading-tight">${c.isClassified?'[ CLASSIFIED ]':c.name}
           ${pl?`<span class="ml-1 text-[9px]" style="color:${pl.color}">[${pl.name}]</span>`:''}
          </div>
         </div>
         <input type="text" value="${role}" placeholder="Rol/Rütbe..."
          class="w-32 bg-black/60 border border-gray-700 text-gray-300 font-mono text-[10px] px-2 py-1 focus:border-cyber-blue outline-none"
          onchange="Admin.setOrgMemberRole('${o.id}','${c.id}',this.value)">
        </div>`;
       }).join('');
      }
     }
     const _oh=document.getElementById('o-heat'); if(_oh) _oh.value=o.heatLevel||'Clean';
 const _ocp=document.getElementById('o-color-pick'); if(_ocp)_ocp.value=o.color||'#00a2ff'; 
    document.getElementById('o-terr').value = o.territories ? o.territories.join(', ') : '';
    document.getElementById('o-img').value = o.image || ''; 
    document.getElementById('o-desc').value = o.description || '';
    

    const oBanner = document.getElementById('o-banner'); if(oBanner) oBanner.value = o.banner || '';
    const oStatus = document.getElementById('o-status'); if(oStatus) oStatus.value = o.status || 'Active';
    const oMembers = document.getElementById('o-members'); if(oMembers) oMembers.value = o.memberCount !== null && o.memberCount !== undefined ? o.memberCount : '';
    const oTags = document.getElementById('o-tags'); if(oTags) oTags.value = (o.tags || []).join(', ');
    const oHier = document.getElementById('o-hierarchy'); if(oHier) oHier.value = o.hierarchy || '';
    const oNotes = document.getElementById('o-notes'); if(oNotes) oNotes.value = o.notes || '';
    const oLinks = document.getElementById('o-links'); 
    if(oLinks) {
     if(Array.isArray(o.links)) oLinks.value = o.links.map(l => l.url || l).filter(Boolean).join(', ');
     else oLinks.value = o.links || '';
    }
    // linked-vehs picker
    const oLinkedVehs = document.getElementById('o-linked-vehs');
    if(oLinkedVehs) oLinkedVehs.value = (o.linkedVehicles || []).join(', ');
    const vehPicker = document.getElementById('o-linked-vehs-picker');
    if(vehPicker) {
      const selectedVehs = new Set(o.linkedVehicles || []);
      vehPicker.innerHTML = DB.vehicles.length === 0
        ? '<div class="text-gray-600 text-[10px]">Henüz araç yok.</div>'
        : DB.vehicles.map(v => {
            var checked = selectedVehs.has(v.id);
            var label = (v.plate ? v.plate + ' — ' : '') + (v.model || v.id);
            var chk = checked ? ' checked' : '';
            var cls = checked ? 'text-white' : 'text-gray-500';
            return '<label class="flex items-center gap-2 cursor-pointer hover:text-white py-0.5 ' + cls + '" onclick="Admin._updateLinkedPicker(\'o-linked-vehs\',\'o-linked-vehs-picker\')">' +
              '<input type="checkbox"' + chk + ' value="' + v.id + '" class="cyber-checkbox" style="width:14px;height:14px">' +
              '<span>' + label + '</span>' +
            '</label>';
          }).join('');
    }

    // linked-props picker
    const oLinkedProps = document.getElementById('o-linked-props');
    if(oLinkedProps) oLinkedProps.value = (o.linkedProperties || []).join(', ');
    const propPicker = document.getElementById('o-linked-props-picker');
    if(propPicker) {
      const selectedProps = new Set(o.linkedProperties || []);
      propPicker.innerHTML = DB.properties.length === 0
        ? '<div class="text-gray-600 text-[10px]">Henüz mülk yok.</div>'
        : DB.properties.map(p => {
            var checked = selectedProps.has(p.id);
            var label = p.name || p.id;
            var chk = checked ? ' checked' : '';
            var cls = checked ? 'text-white' : 'text-gray-500';
            return '<label class="flex items-center gap-2 cursor-pointer hover:text-white py-0.5 ' + cls + '" onclick="Admin._updateLinkedPicker(\'o-linked-props\',\'o-linked-props-picker\')">' +
              '<input type="checkbox"' + chk + ' value="' + p.id + '" class="cyber-checkbox" style="width:14px;height:14px">' +
              '<span>' + label + '</span>' +
            '</label>';
          }).join('');
    }
    document.getElementById('o-btn-del').classList.remove('hidden');
    document.getElementById('org-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
   },
   _updateLinkedPicker(hiddenId, pickerId) {
    const picker = document.getElementById(pickerId);
    const hidden = document.getElementById(hiddenId);
    if(!picker || !hidden) return;
    const checked = Array.from(picker.querySelectorAll('input[type=checkbox]:checked')).map(el => el.value);
    hidden.value = checked.join(', ');
    // Renk güncelle
    picker.querySelectorAll('label').forEach(lbl => {
      const cb = lbl.querySelector('input');
      lbl.className = lbl.className.replace('text-white','text-gray-500').replace('text-gray-500','text-gray-500');
      if(cb && cb.checked) lbl.classList.remove('text-gray-500'), lbl.classList.add('text-white');
    });
   },

   saveOrg(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('o-id').value || `org_${Date.now()}`;
    const terrStr = document.getElementById('o-terr').value;
    const territories = terrStr ? terrStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    const tagsStr = document.getElementById('o-tags') ? document.getElementById('o-tags').value : '';
    const tags = tagsStr ? tagsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    const linksRaw = document.getElementById('o-links') ? document.getElementById('o-links').value : '';
    const links = linksRaw ? linksRaw.split(',').map(u => ({ label: 'LINK', url: u.trim() })).filter(l => l.url) : [];

    const membersVal = document.getElementById('o-members') ? document.getElementById('o-members').value : '';

    const existing = DB.organizations.find(x => x.id === id);
    const data = {
     ...(existing || {}),
     id, 
     name: document.getElementById('o-name').value, 
     color: document.getElementById('o-color').value,
     territories, 
     image: document.getElementById('o-img').value, 
     description: document.getElementById('o-desc').value,
     

     banner: document.getElementById('o-banner') ? document.getElementById('o-banner').value : (existing && existing.banner || ''),
     status:      document.getElementById('o-status')?.value || (existing?.status || 'Active'),
          memberRoles: (() => { try { const _oid=document.getElementById('o-id')?.value; const _o=DB.organizations.find(x=>x.id===_oid); return _o?.memberRoles||{}; } catch(e){ return {}; } })(),
     threatLevel: document.getElementById('o-threat')?.value || (existing?.threatLevel || 'Low'),
     heatLevel:   document.getElementById('o-heat')?.value   || (existing?.heatLevel   || 'Clean'),
     memberCount: membersVal !== '' ? parseInt(membersVal) : null,
     tags,
     hierarchy: document.getElementById('o-hierarchy') ? document.getElementById('o-hierarchy').value : '',
     notes: document.getElementById('o-notes') ? document.getElementById('o-notes').value : '',
     links,
     linkedProperties: (() => {
      const raw = document.getElementById('o-linked-props')?.value || '';
      return raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : (existing?.linkedProperties || []);
     })(),
     linkedVehicles: (() => {
      const raw = document.getElementById('o-linked-vehs')?.value || '';
      return raw ? raw.split(',').map(s=>s.trim()).filter(Boolean) : (existing?.linkedVehicles || []);
     })(),
    };
    const idx = DB.organizations.findIndex(x => x.id === id);
    if(idx >= 0) DB.organizations[idx] = data; else DB.organizations.push(data);
    const oname = document.getElementById('o-name')?.value || 'org';
    const isNewOrg = !DB.organizations.find(x => x.id === id);
    this.finalizeSave(this.loadOrgs.bind(this), 'org',
     isNewOrg ? `Yeni organizasyon oluşturuldu: ${oname}` : `Organizasyon güncellendi: ${oname}`,
     isNewOrg ? 'create' : 'edit', id);
   },

   loadVehicles() {
    const vOwn = document.getElementById('v-owner'); if(vOwn) vOwn.innerHTML = `<option value="">Unregistered</option>` + getSortedChars().map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const list = document.getElementById('admin-list-vehicles');
    if(list) {
     list.innerHTML = DB.vehicles.map(v => `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-cyber-blue/10 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editVeh('${v.id}')">
       <span class="text-white">${v.model} <span class="text-gray-500 ml-2">[${v.plate || 'N/A'}]</span></span>
       <i class="fas fa-edit text-cyber-blue"></i>
      </div>`).join('');
    }
   },
   editVeh(id) {
    const v = DB.vehicles.find(x => x.id === id);
    if(!v) return;
    document.getElementById('v-id').value = v.id; const _vbr=document.getElementById('v-brand');if(_vbr)_vbr.value=v.brand||'';
     const _vyr=document.getElementById('v-year');if(_vyr)_vyr.value=v.year||'';
     const _vcl=document.getElementById('v-color-name');if(_vcl)_vcl.value=v.color||'';
     const _vhp=document.getElementById('v-hp');if(_vhp)_vhp.value=v.hp||'';
     const _vac=document.getElementById('v-acc');if(_vac)_vac.value=v.acc||'';
     const _vts=document.getElementById('v-topspeed');if(_vts)_vts.value=v.topSpeed||'';
     const _vpr=document.getElementById('v-price');if(_vpr)_vpr.value=v.price||'';
     document.getElementById('v-model').value = v.model;
    document.getElementById('v-plate').value = v.plate || ''; document.getElementById('v-perf').value = v.perf || '';
    document.getElementById('v-owner').value = v.owner || ''; document.getElementById('v-heat').value = v.heatLevel || 'Clean';
    document.getElementById('v-mapx').value = v.mapX || ''; document.getElementById('v-mapy').value = v.mapY || '';
    document.getElementById('v-img').value = v.image || ''; document.getElementById('v-link').value = v.link || '';
    document.getElementById('v-btn-del').classList.remove('hidden');
   },
   saveVehicle(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('v-id').value || `veh_${Date.now()}`;
    const data = {
     id,
     brand:    (document.getElementById('v-brand')||{}).value    || '',
     model:    document.getElementById('v-model')?.value    || '',
     vmodel:   document.getElementById('v-model')?.value    || '',
     year:     (document.getElementById('v-year')||{}).value||'',
     color:    (document.getElementById('v-color-name')||{}).value||'',
     hp:       (document.getElementById('v-hp')||{}).value||'',
     acc:      document.getElementById('v-acc')?.value||'',
     topspeedMph: document.getElementById('v-topspeed-mph')?.value||'',
     topSpeed: (document.getElementById('v-topspeed')||{}).value||'',
     price:    (document.getElementById('v-price')||{}).value||'',
     plate:    document.getElementById('v-plate')?.value    || '',
     perf:     document.getElementById('v-perf')?.value     || '',
     owner:    document.getElementById('v-owner')?.value    || '',
     heatLevel: document.getElementById('v-heat').value, 
     mapX: document.getElementById('v-mapx').value || null, mapY: document.getElementById('v-mapy').value || null,
     image: document.getElementById('v-img').value, link: document.getElementById('v-link').value
    };
    const idx = DB.vehicles.findIndex(x => x.id === id);
    if(idx >= 0) DB.vehicles[idx] = data; else DB.vehicles.push(data);
    const vehRecName = document.getElementById('v-model')?.value || 'araç';
    const vehRecId = document.getElementById('v-id')?.value;
    const vehIsNew = !vehRecId || !DB.vehicles.find(x=>x.id===vehRecId);
    this.finalizeSave(this.loadVehicles.bind(this), 'veh',
     vehIsNew ? `Yeni araç oluşturuldu: ${vehRecName}` : `Araç güncellendi: ${vehRecName}`,
     vehIsNew ? 'create' : 'edit', vehRecId);
   },

   loadProperties() {
    const pOwn = document.getElementById('p-owner'); if(pOwn) pOwn.innerHTML = `<option value="">Unregistered</option>` + getSortedChars().map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const list = document.getElementById('admin-list-properties');
    if(list) {
     list.innerHTML = DB.properties.map(p => `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-cyber-purple/10 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editProp('${p.id}')">
       <span class="text-white">${p.name} <span class="text-cyber-purple ml-2">[${p.type}]</span></span>
       <i class="fas fa-edit text-cyber-blue"></i>
      </div>`).join('');
    }
   },
   editProp(id) {
    const p = DB.properties.find(x => x.id === id);
    if(!p) return;
    document.getElementById('p-id').value = p.id; document.getElementById('p-name').value = p.name;
    document.getElementById('p-loc').value = p.location || ''; document.getElementById('p-type').value = p.type || '';
    document.getElementById('p-owner').value = p.owner || ''; 
    document.getElementById('p-mapx').value = p.mapX || ''; document.getElementById('p-mapy').value = p.mapY || '';
    document.getElementById('p-img').value = p.image || '';
    document.getElementById('p-link').value = p.link || ''; document.getElementById('p-desc').value = p.desc || '';
    document.getElementById('p-btn-del').classList.remove('hidden');
   },
   saveProperty(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('p-id').value || `prop_${Date.now()}`;
    const data = {
     id, name: document.getElementById('p-name').value, location: document.getElementById('p-loc').value,
     type: document.getElementById('p-type').value, owner: document.getElementById('p-owner').value,
     mapX: document.getElementById('p-mapx').value || null, mapY: document.getElementById('p-mapy').value || null,
     image: document.getElementById('p-img').value, link: document.getElementById('p-link').value, desc: document.getElementById('p-desc').value
    };
    const idx = DB.properties.findIndex(x => x.id === id);
    if(idx >= 0) DB.properties[idx] = data; else DB.properties.push(data);
    const propRecName = document.getElementById('p-name')?.value || 'mülk';
    const propRecId = document.getElementById('p-id')?.value;
    const propIsNew = !propRecId || !DB.properties.find(x=>x.id===propRecId);
    this.finalizeSave(this.loadProperties.bind(this), 'prop',
     propIsNew ? `Yeni mülk oluşturuldu: ${propRecName}` : `Mülk güncellendi: ${propRecName}`,
     propIsNew ? 'create' : 'edit', propRecId);
   },

   loadEquipments() {
    const eqOwn = document.getElementById('eq-owner'); if(eqOwn) eqOwn.innerHTML = `<option value="">Unregistered</option>` + getSortedChars().map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const list = document.getElementById('admin-list-equipments');
    if(list) {
     list.innerHTML = DB.equipments.map(e => `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-cyber-omega/10 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editEq('${e.id}')">
       <span class="text-white">${e.name} <span class="text-cyber-omega ml-2">[${e.type || 'GEAR'}]</span></span>
       <i class="fas fa-edit text-cyber-omega"></i>
      </div>`).join('');
    }
   },
   editEq(id) {
    const e = DB.equipments.find(x => x.id === id);
    if(!e) return;
    document.getElementById('eq-id').value = e.id; document.getElementById('eq-name').value = e.name;
    document.getElementById('eq-type').value = e.type || ''; document.getElementById('eq-owner').value = e.owner || '';
    document.getElementById('eq-img').value = e.image || ''; document.getElementById('eq-link').value = e.link || ''; 
    document.getElementById('eq-desc').value = e.desc || '';
    document.getElementById('eq-btn-del').classList.remove('hidden');
   },
   saveEquipment(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('eq-id').value || `eq_${Date.now()}`;
    const data = {
     id, name: document.getElementById('eq-name').value, type: document.getElementById('eq-type').value,
     owner: document.getElementById('eq-owner').value, desc: document.getElementById('eq-desc').value,
     image: document.getElementById('eq-img').value, link: document.getElementById('eq-link').value
    };
    const idx = DB.equipments.findIndex(x => x.id === id);
    if(idx >= 0) DB.equipments[idx] = data; else DB.equipments.push(data);
    const eqRecName = document.getElementById('eq-name')?.value || 'ekipman';
    const eqRecId = document.getElementById('eq-id')?.value;
    const eqIsNew = !eqRecId || !DB.equipments.find(x=>x.id===eqRecId);
    this.finalizeSave(this.loadEquipments.bind(this), 'eq',
     eqIsNew ? `Yeni ekipman oluşturuldu: ${eqRecName}` : `Ekipman güncellendi: ${eqRecName}`,
     eqIsNew ? 'create' : 'edit', eqRecId);
   },

   loadContracts() {
    

    const cAss = document.getElementById('con-assigned');
    if(cAss) cAss.innerHTML = '<option value="">Unassigned</option>' + getSortedChars().map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
    

    const susSel = document.getElementById('con-suspect-select');
    if(susSel) susSel.innerHTML = '<option value="">Karakter seç...</option>' + getSortedChars().map(c=>`<option value="${c.id}">${c.name}${c.alias?' ('+c.alias+')':''}</option>`).join('');
    

    const orgSel = document.getElementById('con-org-select');
    if(orgSel) orgSel.innerHTML = '<option value="">Organizasyon seç...</option>' + DB.organizations.map(o=>`<option value="${o.id}">${o.name}</option>`).join('');
    

    const tgtSel = document.getElementById('con-target-select');
    if(tgtSel) tgtSel.innerHTML = '<option value="">— Manuel isim gir —</option>' + getSortedChars().map(c=>`<option value="${c.name}">${c.name}${c.alias?' / '+c.alias:''}</option>`).join('');
    const list = document.getElementById('admin-list-contracts');
    if(list) {
     list.innerHTML = DB.contracts.map(con => `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-cyber-red/10 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editContract('${con.id}')">
       <span class="text-white">${con.target} <span class="text-cyber-red ml-2">[${con.status}]</span></span>
       <i class="fas fa-edit text-cyber-red"></i>
      </div>`).join('');
    }
   },
   editContract(id) {
    const con = DB.contracts.find(x => x.id === id);
    if(!con) return;
    document.getElementById('con-id').value = con.id; 
    document.getElementById('con-target').value = con.target || '';
    const _tgtSel = document.getElementById('con-target-select');
    if(_tgtSel) { const opt = Array.from(_tgtSel.options).find(o=>o.value===con.target); _tgtSel.value = opt ? con.target : ''; }
    document.getElementById('con-issuer').value = con.issuer || ''; 
    document.getElementById('con-reward').value = con.reward || '';
    document.getElementById('con-status').value = con.status || 'Open'; 
    document.getElementById('con-assigned').value = con.assigned || '';
    document.getElementById('con-desc').value = con.desc || '';
    

    const conRisk = document.getElementById('con-risk'); if(conRisk) conRisk.value = con.riskLevel || 'Medium';
    const conDead = document.getElementById('con-deadline'); if(conDead) conDead.value = con.deadline || '';
    const conTags = document.getElementById('con-tags'); if(conTags) conTags.value = (con.tags || []).join(', ');
    const conNotes = document.getElementById('con-notes'); if(conNotes) conNotes.value = con.notes || '';
    const conLink = document.getElementById('con-link'); if(conLink) conLink.value = con.link || '';
    const conArch = document.getElementById('con-archived'); if(conArch) conArch.checked = con.archived || false;
    document.getElementById('con-btn-del').classList.remove('hidden');
    

    const _cb = document.getElementById('con-briefing'); if(_cb) _cb.value = con.briefing||'';
    const _cl = document.getElementById('con-location'); if(_cl) _cl.value = con.location||'';
    const _co = document.getElementById('con-outcome');  if(_co) _co.value = con.outcome||'';
    

    const _csl = document.getElementById('con-suspect-list'); if(_csl) { _csl.innerHTML=''; (con.suspects||[]).forEach(id=>Admin.addConSuspectUI(id)); }
    

    const _col = document.getElementById('con-org-list'); if(_col) { _col.innerHTML=''; (con.linkedOrgs||[]).forEach(id=>Admin.addConOrgUI(id)); }
    

    const _cel = document.getElementById('con-evidence-list'); if(_cel) { _cel.innerHTML=''; (con.evidence||[]).forEach(ev=>Admin.addConEvidenceUI(ev)); }
    

    const _ctl = document.getElementById('con-timeline-list'); if(_ctl) { _ctl.innerHTML=''; (con.timeline||[]).forEach(ev=>Admin.addConTimelineUI(ev)); }
    document.getElementById('con-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
   },
   saveContract(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('con-id').value || `con_${Date.now()}`;
    const tagsRaw = document.getElementById('con-tags') ? document.getElementById('con-tags').value : '';
    const tags = tagsRaw ? tagsRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
    const existing = DB.contracts.find(x => x.id === id);
    const data = {
     ...(existing || {}),
     id, 
     target: document.getElementById('con-target').value, 
     issuer: document.getElementById('con-issuer').value,
     reward: document.getElementById('con-reward').value, 
     status: document.getElementById('con-status').value,
     assigned: document.getElementById('con-assigned').value, 
     desc: document.getElementById('con-desc').value,
     

     riskLevel: document.getElementById('con-risk') ? document.getElementById('con-risk').value : 'Medium',
     deadline: document.getElementById('con-deadline') ? document.getElementById('con-deadline').value : '',
     tags,
     notes: document.getElementById('con-notes') ? document.getElementById('con-notes').value : '',
     link: document.getElementById('con-link') ? document.getElementById('con-link').value : '',
     archived:   document.getElementById('con-archived')?.checked || false,
     linkedCases: existing ? (existing.linkedCases || []) : [],
     briefing:   document.getElementById('con-briefing')?.value || '',
     location:   document.getElementById('con-location')?.value || '',
     outcome:    document.getElementById('con-outcome')?.value  || '',
     suspects:   Array.from(document.querySelectorAll('#con-suspect-list .con-sus-item')).map(el=>el.dataset.charid),
     linkedOrgs: Array.from(document.querySelectorAll('#con-org-list .con-org-item')).map(el=>el.dataset.orgid),
     evidence:   Array.from(document.querySelectorAll('#con-evidence-list .con-ev-item')).map(el=>({label:el.dataset.label,url:el.dataset.url,status:el.dataset.status})),
     timeline:   Array.from(document.querySelectorAll('#con-timeline-list .con-tl-item')).map(el=>({date:el.dataset.date,event:el.dataset.event})),
     linkedOrgs: existing ? (existing.linkedOrgs || []) : [],
    };
    const idx = DB.contracts.findIndex(x => x.id === id);
    if(idx >= 0) DB.contracts[idx] = data; else DB.contracts.push(data);
    const ctarget = document.getElementById('con-target')?.value || 'kontrat';
    const isNewCon = !DB.contracts.find(x => x.id === id);
    this.finalizeSave(this.loadContracts.bind(this), 'con',
     isNewCon ? `Yeni kontrat oluşturuldu: ${ctarget}` : `Kontrat güncellendi: ${ctarget}`,
     isNewCon ? 'create' : 'edit', id);
   },

   loadCases() {
    const charOptions = '<option value="">Select Character...</option>' + getSortedChars().map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    const cTs = document.getElementById('case-tag-select'); if(cTs) cTs.innerHTML = charOptions;
    const cAs = document.getElementById('case-agent-select'); if(cAs) cAs.innerHTML = charOptions;
    const orgOptions = '<option value="">Select Organization...</option>' + DB.organizations.map(o => `<option value="${o.id}">${o.name}</option>`).join('');
    const cOs = document.getElementById('case-org-select'); if(cOs) cOs.innerHTML = orgOptions;
    const conOptions = '<option value="">Select Contract...</option>' + DB.contracts.filter(c=>!c.archived).map(c => `<option value="${c.id}">${c.target} [${c.status}]</option>`).join('');
    const cCon = document.getElementById('case-contract-select'); if(cCon) cCon.innerHTML = conOptions;

    const list = document.getElementById('admin-list-cases');
    if(list) {
     list.innerHTML = DB.cases.map(cf => {
      const status = cf.status || 'Open';
      const priority = cf.priority || 'Medium';
      const isArch = cf.archived ? '<i class="fas fa-archive text-gray-600 ml-1"></i>' : '';
      const pColors = {'Low':'text-cyber-green','Medium':'text-yellow-400','High':'text-orange-500','Critical':'text-cyber-red','Omega':'text-cyber-omega'};
      const pColor = pColors[priority] || 'text-yellow-400';
      return `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-cyber-gold/10 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editCase('${cf.id}')">
       <span class="text-white truncate pr-4">${cf.title} <span class="text-gray-600 text-[10px]">[${status}]</span>${isArch}</span>
       <div class="flex items-center gap-2 flex-shrink-0"><span class="${pColor} font-mono text-[10px]">${priority}</span><i class="fas fa-edit text-cyber-gold"></i></div>
      </div>`;
     }).join('');
    }
   },
   editCase(id) {
    const cf = DB.cases.find(x => x.id === id);
    if(!cf) return;
    document.getElementById('case-id').value = cf.id; 
    document.getElementById('case-title').value = cf.title;
    document.getElementById('case-date').value = cf.date || ''; 
    document.getElementById('case-content').value = cf.content || '';
    

    const cStatus = document.getElementById('case-status'); if(cStatus) cStatus.value = cf.status || 'Open';
    const cPrio = document.getElementById('case-priority'); if(cPrio) cPrio.value = cf.priority || 'Medium';
    const cNotes = document.getElementById('case-notes-field'); if(cNotes) cNotes.value = cf.notes || '';
    const cArch = document.getElementById('case-archived'); if(cArch) cArch.checked = cf.archived || false;
    const cRefs = document.getElementById('case-refs'); 
    if(cRefs) cRefs.value = (cf.externalRefs || []).map(r => typeof r === 'string' ? r : r.url || '').join(', ');
    
    

    const tagList = document.getElementById('case-tag-list');
    if(tagList) {
     tagList.innerHTML = '';
     const suspects = cf.tags || cf.suspects || [];
     suspects.forEach(tId => this.addCaseTagUI(tId));
    }

    

    const contractList = document.getElementById('case-contract-list');
    if(contractList) {
     contractList.innerHTML = '';
     (cf.linkedContracts || []).forEach(cId => this.addCaseContractUI(cId));
    }

    

    const agentList = document.getElementById('case-agent-list');
    if(agentList) {
     agentList.innerHTML = '';
     (cf.assignedAgents || []).forEach(aId => this.addCaseAgentUI(aId));
    }

    

    const orgList = document.getElementById('case-org-list');
    if(orgList) {
     orgList.innerHTML = '';
     (cf.relatedOrgs || []).forEach(oId => this.addCaseOrgUI(oId));
    }

    

    const evList = document.getElementById('case-evidence-list');
    if(evList) {
     evList.innerHTML = '';
     (cf.evidence || []).forEach(ev => this.addCaseEvidenceUI(ev));
    }

    

    const tlList = document.getElementById('case-timeline-list');
    if(tlList) {
     tlList.innerHTML = '';
     (cf.timeline || []).forEach(ev => this.addCaseTimelineUI(ev));
    }

    document.getElementById('case-btn-del').classList.remove('hidden');
    document.getElementById('case-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
   },
   addCaseTag() {
    const target = document.getElementById('case-tag-select').value;
    if(!target) return;
    const existing = Array.from(document.querySelectorAll('#case-tag-list .case-tag-item')).map(el => el.dataset.target);
    if(existing.includes(target)) return;
    this.addCaseTagUI(target);
    document.getElementById('case-tag-select').value = '';
   },
   addCaseTagUI(targetId) {
    const targetChar = DB.characters.find(c => c.id === targetId);
    if(!targetChar) return;
    const div = document.createElement('div');
    div.className = "flex items-center gap-2 bg-gray-900 border border-gray-700 px-2 py-1 case-tag-item";
    div.dataset.target = targetId;
    div.innerHTML = `
     <span class="text-cyber-gold">${targetChar.name}</span>
     <button type="button" class="text-gray-500 hover:text-cyber-red click-sfx hover-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times"></i></button>
    `;
    document.getElementById('case-tag-list').appendChild(div);
   },

   addCaseAgent() {
    const sel = document.getElementById('case-agent-select');
    if(!sel || !sel.value) return;
    const existing = Array.from(document.querySelectorAll('#case-agent-list .case-agent-item')).map(el => el.dataset.agentid);
    if(existing.includes(sel.value)) return;
    this.addCaseAgentUI(sel.value);
    sel.value = '';
   },
   addCaseAgentUI(charId) {
    const c = DB.characters.find(x => x.id === charId);
    if(!c) return;
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 bg-cyber-blue/10 border border-cyber-blue/30 px-2 py-1 case-agent-item';
    div.dataset.agentid = charId;
    div.innerHTML = `<span class="text-cyber-blue font-mono text-xs">${c.isClassified ? '[ REDACTED ]' : c.name}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    document.getElementById('case-agent-list').appendChild(div);
   },

   addCaseOrg() {
    const sel = document.getElementById('case-org-select');
    if(!sel || !sel.value) return;
    const existing = Array.from(document.querySelectorAll('#case-org-list .case-org-item')).map(el => el.dataset.orgid);
    if(existing.includes(sel.value)) return;
    this.addCaseOrgUI(sel.value);
    sel.value = '';
   },
   addCaseOrgUI(orgId) {
    const o = DB.organizations.find(x => x.id === orgId);
    if(!o) return;
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 border px-2 py-1 case-org-item';
    div.dataset.orgid = orgId;
    div.style.borderColor = o.color + '50';
    div.innerHTML = `<span class="font-mono text-xs font-bold" style="color:${o.color}">${o.name}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    document.getElementById('case-org-list').appendChild(div);
   },

   addCaseEvidence() {
    const label = document.getElementById('ev-label') ? document.getElementById('ev-label').value.trim() : '';
    const url = document.getElementById('ev-url') ? document.getElementById('ev-url').value.trim() : '';
    const status = document.getElementById('ev-status') ? document.getElementById('ev-status').value : 'Secured';
    if(!label) return;
    this.addCaseEvidenceUI({ label, url, status });
    if(document.getElementById('ev-label')) document.getElementById('ev-label').value = '';
    if(document.getElementById('ev-url')) document.getElementById('ev-url').value = '';
   },
   addCaseEvidenceUI(ev) {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-3 p-2 bg-black/40 border border-gray-800 case-evidence-item';
    div.dataset.label = ev.label || '';
    div.dataset.url = ev.url || '';
    div.dataset.status = ev.status || 'Secured';
    const sColors = {'Secured':'text-cyber-green','Pending':'text-yellow-400','Lost':'text-cyber-red','Classified':'text-cyber-purple'};
    const sc = sColors[ev.status] || 'text-gray-400';
    div.innerHTML = `<i class="fas fa-file-alt text-gray-600"></i><span class="font-mono text-xs text-white flex-1">${ev.label || ''}</span><span class="${sc} font-mono text-[10px]">${ev.status || ''}</span>${ev.url ? `<a href="${ev.url}" target="_blank" class="text-cyber-blue text-[10px]"><i class="fas fa-link"></i></a>` : ''}<button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    document.getElementById('case-evidence-list').appendChild(div);
   },

   addCaseContract() {
    const sel = document.getElementById('case-contract-select');
    if(!sel || !sel.value) return;
    const existing = Array.from(document.querySelectorAll('#case-contract-list .case-contract-item')).map(el => el.dataset.contractid);
    if(existing.includes(sel.value)) return;
    this.addCaseContractUI(sel.value);
    sel.value = '';
   },
   addCaseContractUI(conId) {
    const con = DB.contracts.find(x => x.id === conId);
    if(!con) return;
    const div = document.createElement('div');
    div.className = 'flex items-center gap-2 bg-cyber-red/10 border border-cyber-red/30 px-2 py-1 case-contract-item';
    div.dataset.contractid = conId;
    div.innerHTML = `<i class="fas fa-crosshairs text-cyber-red text-[10px]"></i><span class="font-mono text-xs text-white">${con.target}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    document.getElementById('case-contract-list').appendChild(div);
   },

   addCaseTimeline() {
    const date = document.getElementById('tl-date') ? document.getElementById('tl-date').value.trim() : '';
    const event = document.getElementById('tl-event') ? document.getElementById('tl-event').value.trim() : '';
    if(!event) return;
    this.addCaseTimelineUI({ date, event });
    if(document.getElementById('tl-date')) document.getElementById('tl-date').value = '';
    if(document.getElementById('tl-event')) document.getElementById('tl-event').value = '';
   },
   addCaseTimelineUI(ev) {
    const div = document.createElement('div');
    div.className = 'flex items-center gap-3 p-2 bg-black/40 border border-gray-800 case-timeline-item';
    div.dataset.date = ev.date || '';
    div.dataset.event = ev.event || ev;
    div.innerHTML = `<span class="font-mono text-[10px] text-gray-500 w-24 flex-shrink-0">${ev.date || '—'}</span><span class="font-mono text-xs text-gray-300 flex-1">${ev.event || ev}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    document.getElementById('case-timeline-list').appendChild(div);
   },
   saveCase(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('case-id').value || `case_${Date.now()}`;
    
    

    const tagEls = document.querySelectorAll('#case-tag-list .case-tag-item');
    const tags = Array.from(tagEls).map(el => el.dataset.target);

    

    const agentEls = document.querySelectorAll('#case-agent-list .case-agent-item');
    const assignedAgents = Array.from(agentEls).map(el => el.dataset.agentid);

    

    const orgEls = document.querySelectorAll('#case-org-list .case-org-item');
    const relatedOrgs = Array.from(orgEls).map(el => el.dataset.orgid);

    

    const evEls = document.querySelectorAll('#case-evidence-list .case-evidence-item');
    const evidence = Array.from(evEls).map(el => ({ label: el.dataset.label, url: el.dataset.url, status: el.dataset.status }));

    

    const tlEls = document.querySelectorAll('#case-timeline-list .case-timeline-item');
    const timeline = Array.from(tlEls).map(el => ({ date: el.dataset.date, event: el.dataset.event }));

    

    const refsRaw = document.getElementById('case-refs') ? document.getElementById('case-refs').value : '';
    const externalRefs = refsRaw ? refsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

    const existing = DB.cases.find(x => x.id === id);
    const data = {
     ...(existing || {}),
     id, 
     title: document.getElementById('case-title').value, 
     date: document.getElementById('case-date').value,
     content: document.getElementById('case-content').value, 
     tags,                           

     suspects: tags,                 

     status: document.getElementById('case-status') ? document.getElementById('case-status').value : 'Open',
     priority: document.getElementById('case-priority') ? document.getElementById('case-priority').value : 'Medium',
     notes: document.getElementById('case-notes-field') ? document.getElementById('case-notes-field').value : '',
     archived: document.getElementById('case-archived') ? document.getElementById('case-archived').checked : false,
     assignedAgents,
     relatedOrgs,
     evidence,
     timeline,
     externalRefs,
     linkedContracts: (() => {
      const els = document.querySelectorAll('#case-contract-list .case-contract-item');
      return Array.from(els).map(el => el.dataset.contractid);
     })(),
    };
    const idx = DB.cases.findIndex(x => x.id === id);
    if(idx >= 0) DB.cases[idx] = data; else DB.cases.push(data);
    const casetitle = document.getElementById('case-title')?.value || 'dava';
    const isNewCase = !DB.cases.find(x => x.id === id);
    this.finalizeSave(this.loadCases.bind(this), 'case',
     isNewCase ? `Yeni dava oluşturuldu: ${casetitle}` : `Dava güncellendi: ${casetitle}`,
     isNewCase ? 'create' : 'edit', id);
   },

   loadLogs() {
    const list = document.getElementById('admin-list-logs');
    if(list) {
     list.innerHTML = DB.logs.map(l => {
      let color = 'text-cyber-blue';
      if(l.type === 'WARNING') color = 'text-cyber-red';
      if(l.type === 'SYSTEM') color = 'text-cyber-green';
      return `
      <div class="flex justify-between items-center p-3 bg-black/40 hover:bg-gray-800 border border-gray-800 cursor-pointer transition-colors hover-sfx click-sfx" onclick="Admin.editLog('${l.id}')">
       <span class="text-gray-400 truncate pr-4">[${l.time}] <span class="${color}">${l.type}:</span> ${l.text}</span>
       <i class="fas fa-edit text-gray-500 flex-shrink-0"></i>
      </div>`
     }).join('');
    }
   },
   editLog(id) {
    const l = DB.logs.find(x => x.id === id);
    if(!l) return;
    document.getElementById('l-id').value = l.id; document.getElementById('l-time').value = l.time;
    document.getElementById('l-type').value = l.type; document.getElementById('l-text').value = l.text;
    document.getElementById('l-btn-del').classList.remove('hidden');
   },
   saveLog(e) {
    if(e) e.preventDefault();
    const id = document.getElementById('l-id').value || `log_${Date.now()}`;
    const data = {
     id, time: document.getElementById('l-time').value, type: document.getElementById('l-type').value, text: document.getElementById('l-text').value
    };
    const idx = DB.logs.findIndex(x => x.id === id);
    if(idx >= 0) DB.logs[idx] = data; else DB.logs.push(data);
    this.finalizeSave(this.loadLogs.bind(this), 'log');
   },

   clearForm(prefix) {
    document.querySelectorAll(`#${prefix}-form input, #${prefix}-form textarea, #${prefix}-form select`).forEach(el => {
     if(el.type === 'checkbox') el.checked = false;
     else el.value = '';
    });
    const delBtn = document.getElementById(`${prefix}-btn-del`);
    if(delBtn) delBtn.classList.add('hidden');
    
    if(prefix === 'char') {
     const cStat = document.getElementById('c-status'); if(cStat) cStat.value = 'Active'; 
     const cThre = document.getElementById('c-threat'); if(cThre) cThre.value = 'Medium';
     const cHeat = document.getElementById('c-heat'); if(cHeat) cHeat.value = 'Clean'; 
     const cRelL = document.getElementById('c-rel-list'); if(cRelL) cRelL.innerHTML = '';
     const cOrgL = document.getElementById('c-org-list'); if(cOrgL) cOrgL.innerHTML = '';
     const cBankL = document.getElementById('c-bank-list'); if(cBankL) cBankL.innerHTML = '';
     const cRepGlobal = document.getElementById('c-rep-global'); if(cRepGlobal) cRepGlobal.value = '0';
     const cRepLevel = document.getElementById('c-rep-level'); if(cRepLevel) cRepLevel.value = 'Unknown';
     const cRepNotes = document.getElementById('c-rep-notes'); if(cRepNotes) cRepNotes.value = '';
     this.updateRepSlider(document.getElementById('c-rep-global') || {value:'0'});
    }
    if(prefix === 'org') {
     const omDiv = document.getElementById('admin-org-members');
     if(omDiv) { omDiv.innerHTML = ''; omDiv.style.display = 'none'; }
    }
    if(prefix === 'case') {
     const tl = document.getElementById('case-tag-list'); if(tl) tl.innerHTML = '';
     const al = document.getElementById('case-agent-list'); if(al) al.innerHTML = '';
     const ol = document.getElementById('case-org-list'); if(ol) ol.innerHTML = '';
     const el = document.getElementById('case-evidence-list'); if(el) el.innerHTML = '';
     const ll = document.getElementById('case-timeline-list'); if(ll) ll.innerHTML = '';
     const cl = document.getElementById('case-contract-list'); if(cl) cl.innerHTML = '';
     ['con-suspect-list','con-org-list','con-evidence-list','con-timeline-list'].forEach(id=>{const el=document.getElementById(id);if(el)el.innerHTML='';});
     const cStatus = document.getElementById('case-status'); if(cStatus) cStatus.value = 'Open';
     const cPrio = document.getElementById('case-priority'); if(cPrio) cPrio.value = 'Medium';
    }
    if(prefix === 'con') {
     const cRisk = document.getElementById('con-risk'); if(cRisk) cRisk.value = 'Medium';
    }
    if(prefix === 'org') {
     const oStatus = document.getElementById('o-status'); if(oStatus) oStatus.value = 'Active';
    }
    if(prefix === 'veh') {
     const vHeat = document.getElementById('v-heat'); if(vHeat) vHeat.value = 'Clean';
    }
    if(prefix === 'org') {
     const oCol = document.getElementById('o-color'); if(oCol) oCol.value = '#00a2ff';
    }
    if(prefix === 'con') {
     const conStat = document.getElementById('con-status'); if(conStat) conStat.value = 'Open';
    }
    if(prefix === 'case') {
     const caseTL = document.getElementById('case-tag-list'); if(caseTL) caseTL.innerHTML = '';
    }
    if(prefix === 'log') {
     const lType = document.getElementById('l-type'); if(lType) lType.value = 'INTEL';
     const lTime = document.getElementById('l-time'); if(lTime) lTime.value = new Date().toLocaleTimeString('en-US', {hour12:true, hour:'2-digit', minute:'2-digit'});
    }
   },
   deleteData(table, idInput) {
    const id = document.getElementById(idInput).value;
    if(!id) return;
    if(confirm("Bu karakteri arşivlemek istediğinden emin misin? Arşivdeki karakterler gizlenir ama silinmez.")) {
     const rec = DB[table].find(x => x.id === id);
     const recName = rec?.name || rec?.target || rec?.title || rec?.model || id;
     const prefix = idInput.split('-')[0];
     if(table === 'characters' && rec) {
       // Karakterler: sil değil arşivle
       rec.isArchived = true;
       this.addAuditLog('edit', `Karakter arşivlendi: ${recName}`, id);
     } else {
       DB[table] = DB[table].filter(x => x.id !== id);
       this.addAuditLog('delete', `Kayıt silindi [${table}]: ${recName}`, id);
     }
     this.finalizeSave(() => {
      if(table === 'characters') this.loadChars();
      if(table === 'organizations') this.loadOrgs();
      if(table === 'vehicles') this.loadVehicles();
      if(table === 'properties') this.loadProperties();
      if(table === 'equipments') this.loadEquipments();
      if(table === 'contracts') this.loadContracts();
      if(table === 'cases') this.loadCases();
      if(table === 'logs') this.loadLogs();
     }, prefix);
    }
   },
   toggleBulkMode() {
    document.body.classList.toggle('bulk-mode');
    const on = document.body.classList.contains('bulk-mode');
    const btn = document.getElementById('bulk-mode-btn');
    if(btn) btn.innerHTML = on ? '<i class="fas fa-times mr-1"></i>İPTAL' : '<i class="fas fa-check-square mr-1"></i>TOPLU SEÇİM';
    ['bulk-delete-btn','bulk-org-btn','bulk-org-select'].forEach(id=>{
     const el=document.getElementById(id); if(el) el.classList.toggle('hidden',!on);
    });
    if(on){
     const sel = document.getElementById('bulk-org-select');
     if(sel) sel.innerHTML = '<option value="">Org seç...</option>' + DB.organizations.map(o=>`<option value="${o.id}">${o.name}</option>`).join('');
    } else {
     document.querySelectorAll('.char-select-cb').forEach(cb=>cb.checked=false);
     document.querySelectorAll('.cyber-card').forEach(c=>c.classList.remove('selected'));
    }
   },
   getSelectedCharIds() {
    return Array.from(document.querySelectorAll('.char-select-cb:checked')).map(cb=>cb.dataset.charid).filter(Boolean);
   },
   bulkDelete() {
    const ids = this.getSelectedCharIds();
    if(!ids.length){ alert('Hiç karakter seçilmedi.'); return; }
    if(!confirm(`${ids.length} karakter silinecek. Emin misin?`)) return;
    ids.forEach(id=>{
     const c=DB.characters.find(x=>x.id===id);
     if(c) this.addAuditLog('delete',`Toplu silme: ${c.name}`,id);
     DB.characters=DB.characters.filter(x=>x.id!==id);
    });
    this.toggleBulkMode();
    Storage.save(DB); UI.renderAll(); this.loadChars();
   },
   bulkChangeOrg() {
    const ids = this.getSelectedCharIds();
    const orgId = document.getElementById('bulk-org-select')?.value;
    if(!ids.length){ alert('Hiç karakter seçilmedi.'); return; }
    if(!orgId){ alert('Org seçilmedi.'); return; }
    const org = DB.organizations.find(o=>o.id===orgId);
    ids.forEach(id=>{
     const c=DB.characters.find(x=>x.id===id); if(!c) return;
     if(!c.organizations) c.organizations=[];
     if(!c.organizations.includes(orgId)) c.organizations.push(orgId);
     c.organization=c.organizations[0];
    });
    this.addAuditLog('edit',`Toplu org değişikliği: ${ids.length} karakter → ${org?.name||orgId}`);
    this.toggleBulkMode();
    Storage.save(DB); UI.renderAll(); this.loadChars();
   },

   addAuditLog(type, message, recordId, operator) {
    const op = operator || window.currentOperator || 'SYSTEM';
    const entry = {
     id: `audit_${Date.now()}`,
     type: type,        

     message: message,
     operator: op,
     recordId: recordId || null,
     timestamp: new Date().toISOString(),
     timeFormatted: formatAuditTime()
    };
    if(!DB.auditLogs) DB.auditLogs = [];
    DB.auditLogs.unshift(entry);
    if(DB.auditLogs.length > 500) DB.auditLogs = DB.auditLogs.slice(0, 500);
    try { SupaSync.pushAuditLog(entry); } catch(e) {}
    Storage.save(DB);
    this.refreshAuditPanel();
    

    try{
     var msgs={char:'Karakter kaydedildi',org:'Organizasyon kaydedildi',veh:'Araç kaydedildi',prop:'Mülk kaydedildi',eq:'Ekipman kaydedildi',con:'Kontrat kaydedildi','case':'Dava kaydedildi',log:'Kayıt eklendi',ev:'Olay kaydedildi'};
     if(typeof showSaveToast==='function') showSaveToast(msgs[prefix]||'Kaydedildi ✓');
    }catch(e){}
   },

   async loadBackups() {
    const list = document.getElementById('backup-list');
    if(!list) return;
    list.innerHTML = '<div class="font-mono text-xs text-gray-500 text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Yükleniyor...</div>';
    const backups = await SupaSync.listBackups();
    if(!backups || backups.length === 0) {
      list.innerHTML = '<div class="font-mono text-xs text-gray-600 text-center py-8">Henüz yedek yok.</div>';
      return;
    }
    list.innerHTML = backups.map(function(b, i) {
      var date = new Date(b.created_at);
      var dateStr = date.toLocaleDateString('tr-TR') + ' ' + date.toLocaleTimeString('tr-TR');
      var isLatest = i === 0;
      var borderClass = isLatest ? 'border-color:#15803d;background:rgba(21,128,61,0.1)' : 'border-color:#1f2937;background:rgba(0,0,0,0.4)';
      var latestBadge = isLatest ? '<span style="color:#4ade80;font-size:9px">● EN SON</span> ' : '';
      return '<div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border:1px solid;font-family:monospace;font-size:12px;margin-bottom:4px;' + borderClass + '">' +
        '<div>' +
          '<div style="color:white;display:flex;align-items:center;gap:8px;margin-bottom:4px">' + latestBadge + dateStr + '</div>' +
          '<div style="color:#6b7280;font-size:10px">' +
            '<span style="color:#60a5fa">' + (b.char_count || 0) + ' karakter</span>' +
            ' · Kaydeden: ' + (b.saved_by || 'SYSTEM') +
          '</div>' +
        '</div>' +
        '<button onclick="Admin.restoreBackup(' + b.id + ', \'' + dateStr + '\', ' + (b.char_count || 0) + ')" ' +
          'style="border:1px solid ' + (isLatest ? '#00a2ff' : '#ff2a2a') + ';color:' + (isLatest ? '#00a2ff' : '#ff2a2a') + ';background:transparent;padding:4px 12px;font-family:monospace;font-size:10px;cursor:pointer;text-transform:uppercase;letter-spacing:1px">' +
          '↩ GERİ YÜKLE' +
        '</button>' +
      '</div>';
    }).join('');
   },

   async restoreBackup(backupId, dateStr, charCount) {
    var current = (DB.characters || []).filter(function(c){return !c.isArchived;}).length;
    if(!confirm('"' + dateStr + '" tarihli yedeği geri yüklemek istiyor musun?\n\nYedek: ' + charCount + ' karakter\nŞu an: ' + current + ' karakter\n\nMevcut durum önce yedeklenecek.')) return;
    const el = document.getElementById('backup-list');
    if(el) el.innerHTML = '<div class="font-mono text-xs text-yellow-400 text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>Geri yükleniyor...</div>';
    const ok = await SupaSync.restoreBackup(backupId);
    if(ok) {
      if(typeof showSaveToast === 'function') showSaveToast('✓ Yedek geri yüklendi!');
      this.loadBackups();
    } else {
      if(el) el.innerHTML = '<div class="font-mono text-xs text-red-400 text-center py-4">Hata! Geri yükleme başarısız.</div>';
    }
   },

   refreshAuditPanel(filterType, searchText) {
    const list = document.getElementById('audit-log-list');
    const countEl = document.getElementById('audit-count');
    if(!list) return;
    // Supabase'den arka planda çek ve birleştir
    try {
     SupaSync.fetchAuditLogs().then(rows => {
      if(!rows || !rows.length) return;
      const existing = new Set((DB.auditLogs||[]).map(e=>e.id));
      let added = 0;
      rows.forEach(r => {
       if(!existing.has(r.log_id)) {
        DB.auditLogs = DB.auditLogs || [];
        DB.auditLogs.push({
         id: r.log_id, type: r.type, message: r.message,
         operator: r.operator, recordId: r.record_id,
         timestamp: r.ts,
         timeFormatted: (() => { try { return new Date(r.ts).toLocaleString('tr-TR',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}); } catch(e){return r.ts;} })()
        });
        added++;
       }
      });
      if(added > 0) {
       DB.auditLogs.sort((a,b) => (b.timestamp||'').localeCompare(a.timestamp||''));
       this.refreshAuditPanel(filterType, searchText);
      }
     }).catch(()=>{});
    } catch(e) {}
    

    document.querySelectorAll('.audit-filter-btn').forEach(b => {
     b.classList.toggle('active', b.dataset.filter === (filterType || 'all'));
     b.style.opacity = (filterType && filterType !== 'all' && b.dataset.filter !== filterType) ? '0.4' : '1';
    });
    const search = searchText || document.getElementById('audit-search')?.value?.toLowerCase() || '';
    let entries = DB.auditLogs || [];
    if(filterType && filterType !== 'all') entries = entries.filter(e => e.type === filterType);
    if(search) entries = entries.filter(e => 
     (e.message||'').toLowerCase().includes(search) || 
     (e.operator||'').toLowerCase().includes(search));
    if(countEl) countEl.textContent = `${entries.length} kayıt`;
    if(entries.length === 0) {
     list.innerHTML = '<div class="font-mono text-xs text-gray-600 text-center py-6">Kayıt bulunamadı.</div>';
     return;
    }
    const typeIcons  = { create:'fa-plus-circle', edit:'fa-pen', delete:'fa-trash', login:'fa-terminal', system:'fa-cog' };
    const typeColors = { create:'text-cyber-green', edit:'text-cyber-blue', delete:'text-cyber-red', login:'text-cyber-gold', system:'text-gray-500' };
    list.innerHTML = entries.slice(0,300).map(e => {
     const icon  = typeIcons[e.type]  || 'fa-circle';
     const color = typeColors[e.type] || 'text-gray-400';
     return `<div class="audit-entry type-${e.type}">
      <div class="flex justify-between items-start gap-2">
       <span class="${color}"><i class="fas ${icon} mr-1.5"></i>${e.message}</span>
       <span class="text-gray-600 whitespace-nowrap flex-shrink-0 text-[9px]">${e.timeFormatted||''}</span>
      </div>
      <div class="text-gray-600 mt-0.5 text-[9px]">OP: <span class="text-cyber-blue">${e.operator}</span></div>
     </div>`;
    }).join('');
   },

   bulkSelectAll(cb) {
    document.querySelectorAll('.bulk-char-cb').forEach(el => el.checked = cb.checked);
    this.onBulkChange();
   },
   onBulkChange() {
    const any = document.querySelectorAll('.bulk-char-cb:checked').length > 0;
    const bar = document.getElementById('bulk-action-btns');
    if(bar) bar.classList.toggle('hidden', !any);
   },
   getSelectedCharIds() {
    return Array.from(document.querySelectorAll('.bulk-char-cb:checked')).map(el=>el.dataset.charid);
   },
   bulkAssignOrg() {
    const ids = this.getSelectedCharIds();
    const orgId = document.getElementById('bulk-org-target')?.value;
    if(!ids.length || !orgId) return;
    const org = DB.organizations.find(o=>o.id===orgId);
    ids.forEach(id => {
     const c = DB.characters.find(x=>x.id===id); if(!c) return;
     if(!c.organizations) c.organizations = c.organization ? [c.organization] : [];
     if(!c.organizations.includes(orgId)) c.organizations.push(orgId);
     c.organization = c.organizations[0];
    });
    this.addAuditLog('edit', `Toplu org atama: ${ids.length} karakter → ${org?.name||orgId}`);
    Storage.save(DB); this.loadChars(); UI.renderAll();
   },
   bulkDelete() {
    const ids = this.getSelectedCharIds();
    if(!ids.length) return;
    if(!confirm(`${ids.length} karakteri silmek istediğine emin misin?`)) return;
    DB.characters = DB.characters.filter(c=>!ids.includes(c.id));
    this.addAuditLog('delete', `Toplu silme: ${ids.length} karakter`);
    Storage.save(DB); this.loadChars(); UI.renderAll();
   },

            renderOrgMemberRow(c, orgId, currentRole) {
                const list = document.getElementById('o-member-list');
                if(!list) return;
                const d = document.createElement('div');
                d.className = 'flex items-center gap-3 p-2 bg-black/40 border border-gray-800 org-member-item';
                d.dataset.charid = c.id;
                d.dataset.role   = currentRole;
                const img = c.image || 'https://ui-avatars.com/api/?name='+encodeURIComponent(c.name)+'&background=000&color=fff&size=32';
                d.innerHTML = `<img src="${img}" class="w-8 h-8 rounded-full object-cover flex-shrink-0 border border-gray-700">
                    <div class="flex-1 min-w-0">
                        <div class="font-mono text-xs text-white truncate">${c.name}</div>
                        <div class="font-mono text-[9px] text-gray-500">${c.alias||''}</div>
                    </div>
                    <input type="text" value="${currentRole}"
                        placeholder="Rol / Rütbe..."
                        class="w-32 bg-black/60 border border-gray-700 text-cyber-blue font-mono text-[10px] px-2 py-1 focus:border-cyber-blue outline-none"
                        oninput="this.parentElement.dataset.role=this.value">`;
                list.appendChild(d);
            },
            setOrgMemberRole(orgId, charId, role) {
                const o = DB.organizations.find(x=>x.id===orgId);
                if(!o) return;
                if(!o.memberRoles) o.memberRoles = {};
                o.memberRoles[charId] = role;
                Storage.save(DB);
                try { addAuditLog('edit','org',orgId,'Rol güncellendi: '+role); } catch(e) {}
            },
            addOrgMember() {
                const sel=document.getElementById('o-member-char');
                const roleEl=document.getElementById('o-member-role');
                if(!sel||!sel.value) return;
                const cid=sel.value; const role=(roleEl?.value||'').trim();
                if(document.querySelector('#o-member-list .org-member-item[data-charid="'+cid+'"]')) return;
                this.addOrgMemberUI({charId:cid, role});
                sel.value=''; if(roleEl) roleEl.value='';
            },
            addOrgMemberUI(m) {
                const c=DB.characters.find(x=>x.id===m.charId); if(!c) return;
                const d=document.createElement('div');
                d.className='flex items-center gap-2 p-2 bg-black/40 border border-gray-800 org-member-item';
                d.dataset.charid=m.charId; d.dataset.role=m.role||'';
                d.innerHTML='<img src="'+(c.image||'https://ui-avatars.com/api/?name='+encodeURIComponent(c.name)+'&background=000&color=fff&size=32')+'" class="w-7 h-7 rounded-full object-cover flex-shrink-0"><span class="font-mono text-xs text-white flex-1">'+c.name+'</span>'+(m.role?'<span class="font-mono text-[10px] border px-1.5 py-0.5" style="color:var(--neon-blue);border-color:rgba(0,162,255,.3)">'+m.role+'</span>':'')+'<button type="button" class="text-gray-600 hover:text-cyber-red click-sfx ml-auto" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>';
                const list=document.getElementById('o-member-list'); if(list) list.appendChild(d);
            },
            filterOrgList(q){const r=(q||'').toLowerCase().trim();document.querySelectorAll('#admin-list-orgs > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});},
            filterVehicleList(q){const r=(q||'').toLowerCase().trim();document.querySelectorAll('#admin-list-vehicles > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});},
            filterPropertyList(q){const r=(q||'').toLowerCase().trim();document.querySelectorAll('#admin-list-properties > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});},
            filterEquipmentList(q){const r=(q||'').toLowerCase().trim();document.querySelectorAll('#admin-list-equipments > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});},
            filterContractList(q){const r=(q||'').toLowerCase().trim();document.querySelectorAll('#admin-list-contracts > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});},
            filterCaseList(q){const r=(q||'').toLowerCase().trim();document.querySelectorAll('#admin-list-cases > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});},
   filterCharList(q){
    const r=(q||'').toLowerCase().trim();
    document.querySelectorAll('#admin-list-chars > div').forEach(i=>{i.style.display=(!r||i.textContent.toLowerCase().includes(r))?'':'none';});
   },
   

   addBankAccount() {
    const bank    = document.getElementById('bank-name')?.value.trim();
    const account = document.getElementById('bank-account')?.value.trim();
    const balance = document.getElementById('bank-balance')?.value.trim()||'';
    const note    = document.getElementById('bank-note')?.value.trim()||'';
    if(!bank && !account) return;
    this.addBankAccountUI({bank,account,balance,note});
    ['bank-name','bank-account','bank-balance','bank-note'].forEach(id=>{
     const el=document.getElementById(id); if(el) el.value='';
    });
   },
   addBankAccountUI(acc) {
    const list = document.getElementById('c-bank-list');
    if(!list) return;
    const d = document.createElement('div');
    d.className = 'bank-account-card bank-item flex items-start gap-3';
    d.dataset.bank    = acc.bank||'';
    d.dataset.account = acc.account||'';
    d.dataset.balance = acc.balance||'';
    d.dataset.note    = acc.note||'';
    d.innerHTML = `
     <i class="fas fa-landmark text-cyber-blue mt-0.5 flex-shrink-0"></i>
     <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 flex-wrap">
       <span class="text-white font-bold">${acc.bank||'—'}</span>
       <span class="text-gray-500 text-[10px]">${acc.account||''}</span>
       ${acc.balance ? `<span class="text-cyber-green text-[10px] border border-cyber-green/30 px-1">${acc.balance}</span>` : ''}
      </div>
      ${acc.note ? `<div class="text-gray-400 text-[10px] mt-0.5 italic">${acc.note}</div>` : ''}
     </div>
     <button type="button" class="text-gray-600 hover:text-cyber-red click-sfx flex-shrink-0" onclick="this.parentElement.remove()">
      <i class="fas fa-times text-xs"></i>
     </button>`;
    list.appendChild(d);
   },
   onConTargetSelect(sel) {
    if(sel.value) {
     const inp = document.getElementById('con-target');
     if(inp) inp.value = sel.value;
    }
   },
   addConSuspect() {
    const sel=document.getElementById('con-suspect-select'); if(!sel||!sel.value) return;
    if(document.querySelector('#con-suspect-list .con-sus-item[data-charid="'+sel.value+'"]')) return;
    this.addConSuspectUI(sel.value); sel.value='';
   },
   addConSuspectUI(cid) {
    const c=DB.characters.find(x=>x.id===cid); if(!c) return;
    const d=document.createElement('div');
    d.className='flex items-center gap-2 bg-cyber-red/10 border border-cyber-red/30 px-2 py-1 con-sus-item';
    d.dataset.charid=cid;
    d.innerHTML=`<span class="font-mono text-xs text-white">${c.name}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx ml-1" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    const list=document.getElementById('con-suspect-list'); if(list) list.appendChild(d);
   },
   

   addConOrg() {
    const sel=document.getElementById('con-org-select'); if(!sel||!sel.value) return;
    if(document.querySelector('#con-org-list .con-org-item[data-orgid="'+sel.value+'"]')) return;
    this.addConOrgUI(sel.value); sel.value='';
   },
   addConOrgUI(oid) {
    const o=DB.organizations.find(x=>x.id===oid); if(!o) return;
    const d=document.createElement('div');
    d.className='flex items-center gap-2 border px-2 py-1 con-org-item';
    d.dataset.orgid=oid;
    d.style.borderColor=o.color+'50'; d.style.color=o.color;
    d.innerHTML=`<span class="font-mono text-xs">${o.name}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx ml-1" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    const list=document.getElementById('con-org-list'); if(list) list.appendChild(d);
   },
   

   addConEvidence() {
    const label=document.getElementById('con-ev-label')?.value.trim(); if(!label) return;
    const url=document.getElementById('con-ev-url')?.value.trim()||'';
    const status=document.getElementById('con-ev-status')?.value||'Pending';
    this.addConEvidenceUI({label,url,status});
    const lel=document.getElementById('con-ev-label'); if(lel) lel.value='';
    const uel=document.getElementById('con-ev-url'); if(uel) uel.value='';
   },
   addConEvidenceUI(ev) {
    const d=document.createElement('div');
    d.className='flex items-center gap-3 p-2 bg-black/40 border border-gray-800 con-ev-item';
    d.dataset.label=ev.label||''; d.dataset.url=ev.url||''; d.dataset.status=ev.status||'Pending';
    const sColors={Secured:'text-cyber-green',Pending:'text-yellow-400',Lost:'text-cyber-red',Classified:'text-purple-400'};
    d.innerHTML=`<i class="fas fa-file-alt text-gray-600"></i><span class="font-mono text-xs text-white flex-1">${ev.label}</span><span class="${sColors[ev.status]||'text-gray-400'} font-mono text-[10px]">${ev.status}</span>${ev.url?`<a href="${ev.url}" target="_blank" class="text-cyber-blue text-[10px] hover-sfx"><i class="fas fa-link"></i></a>`:''}<button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    const list=document.getElementById('con-evidence-list'); if(list) list.appendChild(d);
   },
   

   addConTimeline() {
    const date=document.getElementById('con-tl-date')?.value.trim()||'';
    const event=document.getElementById('con-tl-event')?.value.trim(); if(!event) return;
    this.addConTimelineUI({date,event});
    const del=document.getElementById('con-tl-date'); if(del) del.value='';
    const eel=document.getElementById('con-tl-event'); if(eel) eel.value='';
   },
   addConTimelineUI(ev) {
    const d=document.createElement('div');
    d.className='flex items-center gap-3 p-2 bg-black/40 border border-gray-800 con-tl-item';
    d.dataset.date=ev.date||''; d.dataset.event=ev.event||'';
    d.innerHTML=`<span class="font-mono text-[10px] text-gray-500 w-24 flex-shrink-0">${ev.date||'—'}</span><span class="font-mono text-xs text-gray-300 flex-1">${ev.event}</span><button type="button" class="text-gray-500 hover:text-cyber-red click-sfx" onclick="this.parentElement.remove()"><i class="fas fa-times text-xs"></i></button>`;
    const list=document.getElementById('con-timeline-list'); if(list) list.appendChild(d);
   },
   loadEvents() {
    const list = document.getElementById('admin-list-events');
    if(!list) return;
    list.innerHTML = (DB.events||[]).map(ev => `
     <div class="flex justify-between items-center p-3 bg-black/40 border border-gray-800 cursor-pointer hover:bg-purple-900/20 transition-colors hover-sfx click-sfx" onclick="Admin.editEvent('${ev.id}')">
      <span style="color:${ev.color||'#a855f7'}"><i class="fas fa-${ev.icon||'bolt'} mr-2"></i>${ev.title}</span>
      <span class="text-gray-500 text-[10px]">${ev.date||''}</span>
     </div>`).join('') || '<div class="text-gray-600 font-mono text-xs text-center py-4">Henüz olay yok.</div>';
   },
   editEvent(id) {
    const ev = (DB.events||[]).find(x=>x.id===id); if(!ev) return;
    const f = (fid,val) => { const el=document.getElementById(fid); if(el) el.value=val??''; };
    f('ev-id',ev.id); f('ev-title',ev.title); f('ev-date',ev.date);
    f('ev-icon',ev.icon||'bolt'); f('ev-mapx',ev.mapX??''); f('ev-mapy',ev.mapY??'');
    f('ev-color',ev.color||'#a855f7'); f('ev-desc',ev.desc||'');
    const del=document.getElementById('ev-btn-del'); if(del) del.classList.remove('hidden');
   },
   saveEvent(e) {
    if(e) e.preventDefault();
    if(!DB.events) DB.events=[];
    const g = id => document.getElementById(id)?.value||'';
    const id = g('ev-id') || `ev_${Date.now()}`;
    const isNew = !DB.events.find(x=>x.id===id);
    const data = {
     id, title:g('ev-title'), date:g('ev-date'), icon:g('ev-icon')||'bolt',
     mapX: g('ev-mapx')!==''?parseFloat(g('ev-mapx')):null,
     mapY: g('ev-mapy')!==''?parseFloat(g('ev-mapy')):null,
     color: g('ev-color')||'#a855f7', desc:g('ev-desc'), linkedOrgs:[], linkedChars:[]
    };
    const idx = DB.events.findIndex(x=>x.id===id);
    if(idx>=0) DB.events[idx]=data; else DB.events.push(data);
    this.addAuditLog(isNew?'create':'edit', `${isNew?'Yeni olay':'Olay güncellendi'}: ${data.title}`, id);
    Storage.save(DB); this.loadEvents(); this.clearForm('ev'); UI.renderRadar();
   },
   deleteEvent() {
    const id = document.getElementById('ev-id')?.value; if(!id) return;
    if(!confirm('Bu olayı silmek istiyor musun?')) return;
    const ev = (DB.events||[]).find(x=>x.id===id);
    DB.events = (DB.events||[]).filter(x=>x.id!==id);
    this.addAuditLog('delete',`Olay silindi: ${ev?.title||id}`,id);
    Storage.save(DB); this.loadEvents(); this.clearForm('ev'); UI.renderRadar();
   },

   filterAudit(type) {
    this.refreshAuditPanel(type);
   },

   clearAuditLog() {
    if(!confirm('Tüm işlem geçmişi silinecek. Emin misin?')) return;
    DB.auditLogs = [];
    Storage.save(DB);
    this.refreshAuditPanel();
    this.addAuditLog('system', 'İşlem geçmişi temizlendi', null, window.currentOperator||'SYSTEM');
   },

   updateRepSlider(input) {
    const val = parseInt(input.value) || 0;
    const valEl = document.getElementById('c-rep-global-val');
    if(valEl) {
     valEl.textContent = (val > 0 ? '+' : '') + val;
     valEl.className = 'font-mono text-sm font-bold w-12 text-right ' +
      (val >= 75 ? 'text-purple-400' : val >= 40 ? 'text-orange-400' :
      val >= 10 ? 'text-cyber-blue' : val <= -40 ? 'text-cyber-red' :
      val <= -10 ? 'text-yellow-400' : 'text-gray-400');
    }
    const fill = document.getElementById('c-rep-bar-fill');
    if(fill) {
     const pct = ((val + 100) / 200) * 100;
     fill.style.width = pct + '%';
     fill.style.background = val >= 75 ? '#a855f7' : val >= 40 ? '#f97316' :
      val >= 10 ? 'var(--neon-blue)' : val <= -40 ? 'var(--neon-red)' :
      val <= -10 ? '#facc15' : '#6b7280';
    }
   },

   finalizeSave(reloadFn, prefix, auditMsg, auditType, recordId) {
    Storage.save(DB);
    reloadFn();
    this.clearForm(prefix);
    UI.renderAll();
    if (prefix === 'org') UI.renderFilters();
    

    if(auditMsg) {
     this.addAuditLog(auditType || 'edit', auditMsg, recordId || null);
    }
    this.refreshAuditPanel();
   },
   exportRecord(prefix) {
    let id, data, type;
    if(prefix === 'char') { id = document.getElementById('c-id').value; type = 'character'; data = DB.characters.find(x => x.id === id); }
    else if(prefix === 'org') { id = document.getElementById('o-id').value; type = 'organization'; data = DB.organizations.find(x => x.id === id); }
    else if(prefix === 'veh') { id = document.getElementById('v-id').value; type = 'vehicle'; data = DB.vehicles.find(x => x.id === id); }
    else if(prefix === 'prop') { id = document.getElementById('p-id').value; type = 'property'; data = DB.properties.find(x => x.id === id); }
    else if(prefix === 'eq') { id = document.getElementById('eq-id').value; type = 'equipment'; data = DB.equipments.find(x => x.id === id); }
    if(!data) return alert("Select a record first.");
    const exportObj = { recordType: type, data: data };
    const a = document.createElement("a");
    a.href = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(exportObj, null, 2));
    a.download = `NYC_${type}_${data.name || data.model || 'record'}.json`;
    document.body.appendChild(a); a.click(); a.remove();
   },
   importRecord(event, prefix) {
    const file = event.target.files[0];
    if(!file) return;
    const r = new FileReader();
    r.onload = (ev) => {
     try {
      const parsed = JSON.parse(ev.target.result);
      if(!parsed.recordType || !parsed.data) return alert("Invalid individual record file.");
      const data = parsed.data;

      if(prefix === 'char' && parsed.recordType === 'character') {
       document.getElementById('c-id').value = data.id || ''; document.getElementById('c-name').value = data.name || '';
       document.getElementById('c-alias').value = data.alias || ''; document.getElementById('c-org').value = data.organization || '';
       document.getElementById('c-status').value = data.status || 'Active'; document.getElementById('c-threat').value = data.threatLevel || 'Medium';
       document.getElementById('c-heat').value = data.heatLevel || 'Clean'; document.getElementById('c-classified').checked = data.isClassified || false;
       document.getElementById('c-mapx').value = data.mapX || ''; document.getElementById('c-mapy').value = data.mapY || '';
       document.getElementById('c-img').value = data.image || ''; document.getElementById('c-link').value = data.link || ''; 
       document.getElementById('c-story').value = data.story || '';
       const relList = document.getElementById('c-rel-list'); if(relList) relList.innerHTML = '';
       if(data.relationships) data.relationships.forEach(r => Admin.addRelUI(r.targetId, r.type));
       document.getElementById('c-btn-del').classList.remove('hidden');
      } else if(prefix === 'org' && parsed.recordType === 'organization') {
       document.getElementById('o-id').value = data.id || ''; document.getElementById('o-name').value = data.name || '';
       document.getElementById('o-color').value = data.color || '#00a2ff'; document.getElementById('o-terr').value = data.territories ? data.territories.join(', ') : '';
       document.getElementById('o-img').value = data.image || ''; document.getElementById('o-desc').value = data.description || '';
       document.getElementById('o-btn-del').classList.remove('hidden');
      } else if(prefix === 'veh' && parsed.recordType === 'vehicle') {
       document.getElementById('v-id').value = data.id || ''; document.getElementById('v-model').value = data.model || '';
       document.getElementById('v-plate').value = data.plate || ''; document.getElementById('v-perf').value = data.perf || '';
       document.getElementById('v-owner').value = data.owner || ''; document.getElementById('v-heat').value = data.heatLevel || 'Clean';
       document.getElementById('v-mapx').value = data.mapX || ''; document.getElementById('v-mapy').value = data.mapY || '';
       document.getElementById('v-img').value = data.image || ''; document.getElementById('v-link').value = data.link || '';
       document.getElementById('v-btn-del').classList.remove('hidden');
      } else if(prefix === 'prop' && parsed.recordType === 'property') {
       document.getElementById('p-id').value = data.id || ''; document.getElementById('p-name').value = data.name || '';
       document.getElementById('p-loc').value = data.location || ''; document.getElementById('p-type').value = data.type || '';
       document.getElementById('p-owner').value = data.owner || ''; 
       document.getElementById('p-mapx').value = data.mapX || ''; document.getElementById('p-mapy').value = data.mapY || '';
       document.getElementById('p-img').value = data.image || ''; document.getElementById('p-link').value = data.link || ''; document.getElementById('p-desc').value = data.desc || '';
       document.getElementById('p-btn-del').classList.remove('hidden');
      } else if(prefix === 'eq' && parsed.recordType === 'equipment') {
       document.getElementById('eq-id').value = data.id || ''; document.getElementById('eq-name').value = data.name || '';
       document.getElementById('eq-type').value = data.type || ''; document.getElementById('eq-owner').value = data.owner || ''; 
       document.getElementById('eq-img').value = data.image || ''; document.getElementById('eq-link').value = data.link || ''; document.getElementById('eq-desc').value = data.desc || '';
       document.getElementById('eq-btn-del').classList.remove('hidden');
      } else { alert("Record type mismatch. Ensure you upload to the correct editor."); }
      
      event.target.value = ''; alert("Record loaded into the form. Click COMMIT CHANGES to save.");
     } catch(e) { alert("Error parsing JSON"); }
    };
    r.readAsText(file);
   }
  };

  

  (function() {
   const cursor = document.getElementById('custom-cursor');
   const dot = document.getElementById('cursor-dot');
   const ring = document.getElementById('cursor-ring');
   if(!cursor) return;

   let mx = -100, my = -100;
   let rx = -100, ry = -100;
   let raf;

   document.addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; });

   function animateCursor() {
    

    dot.style.left   = mx + 'px';
    dot.style.top    = my + 'px';
    

    rx += (mx - rx) * 0.18;
    ry += (my - ry) * 0.18;
    ring.style.left = rx + 'px';
    ring.style.top  = ry + 'px';
    const ch = document.getElementById('cursor-crosshair-h');
    const cv = document.getElementById('cursor-crosshair-v');
    if(ch) { ch.style.left = mx + 'px'; ch.style.top = my + 'px'; }
    if(cv) { cv.style.left = mx + 'px'; cv.style.top = my + 'px'; }
    raf = requestAnimationFrame(animateCursor);
   }
   animateCursor();

   

   const hoverSels = 'button, a, [onclick], .cyber-card, .tab-item, .nav-link, .admin-tab, label[for], input[type=checkbox], input[type=radio], input[type=range], .cursor-pointer, .hover-sfx, .click-sfx';
   document.addEventListener('mouseover', e => {
    if(e.target.closest(hoverSels)) document.body.classList.add('cursor-hover');
   });
   document.addEventListener('mouseout', e => {
    if(e.target.closest(hoverSels)) document.body.classList.remove('cursor-hover');
   });
   document.addEventListener('mousedown', () => document.body.classList.add('cursor-click'));
   document.addEventListener('mouseup',   () => document.body.classList.remove('cursor-click'));
   document.addEventListener('mouseleave', () => { cursor.style.opacity = '0'; });
   document.addEventListener('mouseenter', () => { cursor.style.opacity = '1'; });
  })();
  

  window.addEventListener('DOMContentLoaded', () => {
   // init-screen: click, touch ve 10 saniye otomatik geçiş
   (function() {
    var booted = false;
    function startBoot() {
     if(booted) return;
     booted = true;
     try { UI.bootSequence(); } catch(e) { try { UI.initApp(); } catch(e2) {} }
    }
    var scr = document.getElementById('init-screen');
    if(scr) {
     scr.addEventListener('click',      startBoot, {once:true});
     scr.addEventListener('touchstart', startBoot, {once:true, passive:true});
    }
    // B planı: 10 saniye sonra otomatik başlat (iPhone uyumluluğu için)
    setTimeout(startBoot, 10000);
   })();
  });

  


// Player localStorage'dan oku (sayfa yüklenince)
(function(){
  const s = localStorage.getItem(CFG.playerKey);
  if(s){
    try{
      const p = JSON.parse(s);
      window.currentOperator = p.name;
      window.currentPlayer = p;
    } catch(e){}
  }
})();


// Global erişim için window'a ata
window.UI = UI;
window.Admin = Admin;
window.Storage = Storage;
window.Tabs = Tabs;
window.SFX = SFX;
window.SupaSync = SupaSync;
window.DB = DB;
