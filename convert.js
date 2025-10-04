
const fs = require('fs');
const sqlite3 = require('sqlite3');

const surah_data = JSON.parse(fs.readFileSync('quran.json', 'utf8'));

const db = new sqlite3.Database('quran.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS verses (
        id INTEGER PRIMARY KEY,
        surah_id INTEGER,
        verse_number INTEGER,
        english_text TEXT,
        arabic_text TEXT,
        juz_number INTEGER,
        page_number INTEGER
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS surahs (
        surah_id INTEGER PRIMARY KEY,
        arabic_name TEXT,
        english_name TEXT,
        verse_count INTEGER
    )`);

    const verse_stmt = db.prepare(`INSERT INTO verses (surah_id, verse_number, english_text, arabic_text, juz_number, page_number) VALUES (?, ?, ?, ?, ?, ?)`);

    const surah_stmt = db.prepare(`INSERT INTO surahs (surah_id, arabic_name, english_name, verse_count) VALUES (?, ?, ?, ?)`);

    surah_data.forEach(surah => {
        surah_stmt.run(surah.id, surah.name, surah.transliteration, surah.total_verses);

        surah.verses.forEach(ayah => {
            verse_stmt.run(surah.id, ayah.id, ayah.translation, ayah.text, ayah.juz, ayah.pageNumber);
        })
    })
    
    surah_stmt.finalize();
    verse_stmt.finalize();
});

db.close(() => {
    console.log("Quran data saved to quran.db");
});

