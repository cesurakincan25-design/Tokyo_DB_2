/**
 * config.js — TOKYO_DB
 * Bu dosyayı TOKYO_DB reposuna koy.
 * Supabase credentials, oyuncu listesi ve TOKYO'ya özgü ayarları içerir.
 */
window.RPCONFIG = {
  // ── Supabase ──────────────────────────────────────────────
  supaUrl:       'https://nytmjhdxlpttowxogxci.supabase.co',
  supaKey:       'sb_publishable_1n7_W593pAMECio0s-Sgsg_G5vAgyDY',
  tableName:     'tokyo_db',

  // ── LocalStorage anahtarları ───────────────────────────────
  storageKey:    'tokyo_db_v10',
  storageLegacy: 'tokyo_db_v8',
  sfxKey:        'tokyo_sfx_muted',
  langKey:       'tokyo_lang',
  themeKey:      'tokyo_theme',
  playerKey:     'tokyo_active_player',

  // ── Açılış modu ───────────────────────────────────────────
  // 'splash'        → init-screen'e tıklayınca boot animasyonu (NYC tarzı)
  // 'player-select' → direkt oyuncu seçim ekranı (TOKYO tarzı)
  bootMode:      'player-select',
  colorPhotos:   true,   // true → renkli fotoğraf, false → grayscale (NYC tarzı)

  // ── Evren bilgisi ─────────────────────────────────────────
  universe:      'TOKYO RP',

  // ── Oyuncu listesi ────────────────────────────────────────
  // Tokyo'nun renk paleti sakura/torii/bambu/altın/mor
  players: [
    { id: 'eren',  name: 'Eren',  role: 'admin', color: '#e8728a' },
//  { id: 'melih', name: 'Melih', role: 'admin', color: '#d04020' },
//  { id: 'tuna',  name: 'Tuna',  role: 'admin', color: '#2d7a4e' },
    { id: 'nes',   name: 'Nes',   role: 'admin', color: '#c8a84b' },
    { id: 'aley',  name: 'Aley',  role: 'admin', color: '#7b4a8a' }
  ],

  // ── Başlangıç veritabanı (Supabase boşsa kullanılır) ──────
  seedDB: {
    metadata: {
      version: '8.5',
      universe: 'TOKYO RP',
      lastUpdated: new Date().toISOString()
    },
    organizations: [],
    characters: [],
    vehicles: [],
    properties: [],
    equipments: [],
    contracts: [],
    cases: [],
    logs: []
  }
};
