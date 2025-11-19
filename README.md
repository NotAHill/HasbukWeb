# Hasbuk Web Version

[![Vercel Deployment](https://img.shields.io/badge/Deployed%20on-Vercel-black?logo=vercel)]()  
[![website Status](https://img.shields.io/website?url=https%3A%2F%2Fhasbuk-web.vercel.app)]()  
![GitHub last commit](https://img.shields.io/github/last-commit/NotAHill/HasbukWeb)  
![GitHub repo size](https://img.shields.io/github/repo-size/NotAHill/HasbukWeb)  

ٱلسَّلَامُ عَلَيْكُمْ وَرَحْمَةُ ٱللَّٰهِ وَبَرَكَاتُهُ

Hasbuk Web is a Quran memorisation tool to assist with the memorisation/understanding of the Quran. You can find the most recent release here: https://hasbuk-web.vercel.app

## How to use

Quran teachers often pick random ayahs of the Quran to test a student's knowledge and ask them to continue from there until they say "Hasbuk" (حسبك meaning enough)

The core of this app follows from that - You input a range of the Quran that you want to test yourself or someone else on and then press "Select Random Ayah". This picks from that range and you go to the next ayah until you say "Hasbuk" when they have read enough and are ready to move on.

Another way that people have used it is to test ayah translation, from Arabic to English and vice versa. The Saheeh Internation translation is currently being used in the app. 

Another way that people have used the app is to test which Surah/Juz a particular verse belongs

## Features

1. You can select multiple ranges (from Surah and Juz) and the selection algorithm will select an ayah from any one of those ranges.
2. View English/Arabic translations of a verse and see Juz/Ayah/Surah info associated with it.
3. Double tap the Juz/Ayah/Surah info to hide/show it
4. You can choose 'Add to Home Screen' on your mobile device browser to save it as an app that can be used offline.

## Files

`quran.json` - A json of each surah and ayah in the quran with juz and page number information.
`quran.db` - A sqlite3 DB with 'surahs' and 'verses' tables. This is what is used in the website.
`convert.js` - A conversion script to convert the quran.json to quran.db
`index.html` - Single HTML/CSS/Vanilla JS file where all the code is contained
`manifest.json`/`service-worker.json` - Used to enable offline usage for the website when you press 'Add to Home Screen'.


## Contribute

This is an open source project, so please feel free to create forks/PRs to contribute to this project and report any bugs you find in the Github Issues tab.



