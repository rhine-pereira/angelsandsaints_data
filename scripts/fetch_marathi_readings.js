
import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to get ordinal suffix (st, nd, rd, th)
function getOrdinalSuffix(day) {
    if (day > 3 && day < 21) return 'th';
    switch (day % 10) {
        case 1: return "st";
        case 2: return "nd";
        case 3: return "rd";
        default: return "th";
    }
}

// Helper to get day name
function getDayName(date) {
    return date.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
}

function formatDateYmd(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

const ORDINAL_WORDS = [
    "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
    "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
    "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth",
    "thirty-first", "thirty-second", "thirty-third", "thirty-fourth"
];

function getEaster(year) {
    const f = Math.floor,
        G = year % 19,
        C = f(year / 100),
        H = (C - f(C / 4) - f((8 * C + 13) / 25) + 19 * G + 15) % 30,
        I = H - f(H / 28) * (1 - f(29 / (H + 1)) * f((21 - G) / 11)),
        J = (year + f(year / 4) + I + 2 - C + f(C / 4)) % 7,
        L = I - J,
        month = 3 + f((L + 40) / 44),
        day = L + 28 - 31 * f(month / 4);
    return new Date(year, month - 1, day);
}

function getLiturgicalSeasonAndWeek(date) {
    const year = date.getFullYear();

    // Epiphany: Sunday between Jan 2 and Jan 8
    let epiphany = new Date(year, 0, 1);
    while (true) {
        if (epiphany.getDay() === 0 && epiphany.getDate() >= 2 && epiphany.getDate() <= 8) break;
        epiphany.setDate(epiphany.getDate() + 1);
        if (epiphany.getMonth() > 0) break; // Safety break
    }

    const easter = getEaster(year);
    const ashWed = new Date(easter);
    ashWed.setDate(easter.getDate() - 46);

    // Ordinary Time (Before Lent)
    if (date > epiphany && date < ashWed) {
        const diffTime = Math.abs(date - epiphany);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        const week = Math.floor(diffDays / 7);
        if (week > 0) return { season: 'ordinary', week: week };
    }

    return null;
}

function generateUrl(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');

    // Day in URL usually doesn't have leading zero? e.g. 5th, not 05th.
    // Based on standard blogspot behavior.
    const day = date.getDate();
    const dayName = getDayName(date);
    const suffix = getOrdinalSuffix(day);

    // Special logic for Sundays
    if (date.getDay() === 0) { // Sunday
        const litInfo = getLiturgicalSeasonAndWeek(date);
        if (litInfo && litInfo.season === 'ordinary') {
            const ordinalWord = ORDINAL_WORDS[litInfo.week] || litInfo.week;
            // Pattern: https://marathibiblereading.blogspot.com/YYYY/MM/marathi-bible-reading-ordinary-second.html
            return `https://marathibiblereading.blogspot.com/${year}/${month}/marathi-bible-reading-${litInfo.season}-${ordinalWord}.html`;
        }
    }

    // URL Construction
    // Pattern: https://marathibiblereading.blogspot.com/YYYY/MM/marathi-bible-reading-WEEKDAY-DAYth.html
    return `https://marathibiblereading.blogspot.com/${year}/${month}/marathi-bible-reading-${dayName}-${day}${suffix}.html`;
}

function buildFeedUrlForDate(date) {
    const dateStr = formatDateYmd(date);
    const tzOffset = '+05:30';
    const min = `${dateStr}T00:00:00${tzOffset}`;
    const max = `${dateStr}T23:59:59${tzOffset}`;
    return `https://marathibiblereading.blogspot.com/feeds/posts/default?alt=json&max-results=150&published-min=${encodeURIComponent(min)}&published-max=${encodeURIComponent(max)}`;
}

function isSameLocalDate(a, b) {
    return a.getFullYear() === b.getFullYear()
        && a.getMonth() === b.getMonth()
        && a.getDate() === b.getDate();
}

function extractYearFromUrl(url) {
    const match = url.match(/\/(\d{4})\//);  
    return match ? parseInt(match[1], 10) : null;
}

function extractDateComponentsFromUrl(url) {
    const yearMatch = url.match(/\/(\d{4})\/(\d{2})\//);  
    if (!yearMatch) return null;
    return {
        year: parseInt(yearMatch[1], 10),
        month: parseInt(yearMatch[2], 10)
    };
}

function extractDayFromTitle(title) {
    const match = title.match(/(\d+)(st|nd|rd|th)/i);
    return match ? parseInt(match[1], 10) : null;
}

function validatePostMatchesDate(postUrl, postTitle, targetDate) {
    const components = extractDateComponentsFromUrl(postUrl);
    if (!components) return false;
    
    if (components.year !== targetDate.getFullYear()) return false;
    if (components.month !== targetDate.getMonth() + 1) return false;
    
    const dayFromTitle = extractDayFromTitle(postTitle);
    if (dayFromTitle && dayFromTitle !== targetDate.getDate()) return false;
    
    return true;
}

function scoreEntryForDate(entry, targetDate) {
    const day = targetDate.getDate();
    const suffix = getOrdinalSuffix(day);
    const dayName = getDayName(targetDate);
    const title = (entry?.title?.$t || '').toLowerCase();

    let score = 0;
    if (title.includes(dayName)) score += 3;
    if (title.includes(`${day}${suffix}`)) score += 3;
    if (title.includes('marathi') && title.includes('bible') && title.includes('reading')) score += 1;
    return score;
}

async function findPostUrlFromFeed(targetDate) {
    try {
        const feedUrl = buildFeedUrlForDate(targetDate);
        const response = await axios.get(feedUrl);
        const entries = response?.data?.feed?.entry || [];
        if (!entries.length) return null;

        const validEntries = entries.filter(entry => {
            const published = entry?.published?.$t;
            if (!published) return false;
            const publishedDate = new Date(published);
            return isSameLocalDate(publishedDate, targetDate);
        });

        const scored = (validEntries.length ? validEntries : entries)
            .map(entry => ({
                entry,
                score: scoreEntryForDate(entry, targetDate)
            }))
            .sort((a, b) => b.score - a.score);

        const best = scored[0]?.entry;
        const link = best?.link?.find(l => l.rel === 'alternate')?.href;
        const title = best?.title?.$t || '';
        if (!link) return null;

        if (!validatePostMatchesDate(link, title, targetDate)) {
            console.log(`Feed found post but date doesn't match target date`);
            return null;
        }

        return {
            url: link,
            title: title,
            source: 'feed'
        };
    } catch (err) {
        console.warn('Feed lookup failed:', err.message);
        return null;
    }
}

async function findPostUrlFromSearch(targetDate) {
    const day = targetDate.getDate();
    const suffix = getOrdinalSuffix(day);
    const dayName = getDayName(targetDate);
    const queries = [
        `${dayName} ${day}${suffix}`,
        `${day}${suffix}`,
        `${dayName} marathi bible reading`
    ];

    for (const query of queries) {
        try {
            const searchUrl = `https://marathibiblereading.blogspot.com/search?q=${encodeURIComponent(query)}`;
            const response = await axios.get(searchUrl);
            const $ = cheerio.load(response.data);

            const candidates = [];
            $('.post, .hentry, article').each((_, el) => {
                const link = $(el).find('h3.post-title a, h2.post-title a, a.post-title-link').first().attr('href');
                if (!link) return;
                const title = $(el).find('h3.post-title, h2.post-title, a.post-title-link').first().text().trim();
                if (validatePostMatchesDate(link, title, targetDate)) {
                    candidates.push({ url: link, title });
                }
            });

            if (candidates.length) {
                return { url: candidates[0].url, title: candidates[0].title || '', source: 'search' };
            }
        } catch (err) {
            console.warn(`Search lookup failed for query "${query}":`, err.message);
        }
    }
    return null;
}

async function resolvePostUrlForDate(targetDate) {
    const directUrl = generateUrl(targetDate);
    try {
        const directResponse = await axios.get(directUrl, { validateStatus: status => status < 500 });
        if (directResponse.status === 200) {
            return { url: directUrl, html: directResponse.data, source: 'direct' };
        }
    } catch (err) {
        console.warn(`Direct URL lookup failed for ${directUrl}:`, err.message);
    }

    const feedResult = await findPostUrlFromFeed(targetDate);
    if (feedResult?.url) {
        return { url: feedResult.url, source: feedResult.source, title: feedResult.title };
    }

    const searchResult = await findPostUrlFromSearch(targetDate);
    if (searchResult?.url) {
        return { url: searchResult.url, source: searchResult.source, title: searchResult.title };
    }

    return null;
}

// Helper to delay (to be polite)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Find the latest processed date from the file system
function getLastProcessedDate(baseDir) {
    // Default start date if nothing found: Today
    let latestDate = new Date();
    latestDate.setHours(0, 0, 0, 0);

    // We want to start checking from current time? No, let's look at what we have.
    // If the folder is empty, we start from today. 
    // If we have files, we assume we want to continue from the last one provided it's in the future or recent past.
    // Actually, simply: Scan for the max date.

    if (!fs.existsSync(baseDir)) return latestDate;

    try {
        const years = fs.readdirSync(baseDir).filter(y => /^\d{4}$/.test(y)).sort();
        if (years.length === 0) return latestDate;

        const lastYear = years[years.length - 1];
        const yearPath = path.join(baseDir, lastYear);

        const months = fs.readdirSync(yearPath).filter(m => /^\d{2}$/.test(m)).sort();
        if (months.length === 0) return latestDate; // Should likely check year itself if empty

        const lastMonth = months[months.length - 1];
        const monthPath = path.join(yearPath, lastMonth);

        const files = fs.readdirSync(monthPath).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
        if (files.length === 0) return latestDate;

        const lastFile = files[files.length - 1];
        const dateStr = lastFile.replace('.json', '');

        // Return the date of the last file
        return new Date(dateStr);
    } catch (e) {
        console.warn("Error finding last date, defaulting to today:", e);
        return latestDate;
    }
}

async function fetchAndSave(targetDate, baseDir) {
    const resolved = await resolvePostUrlForDate(targetDate);
    if (!resolved?.url) {
        console.log(`No post found for ${formatDateYmd(targetDate)}. Stopping.`);
        return false;
    }

    const targetUrl = resolved.url;
    const year = targetDate.getFullYear();
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');
    const day = String(targetDate.getDate()).padStart(2, '0');
    const dateStr = `${year}-${month}-${day}`;

    // Output Path
    const outputDir = path.join(baseDir, String(year), month);
    const outputFile = path.join(outputDir, `${dateStr}.json`);

    // Check if exists? Maybe. For now, let's try to fetch anyway to update content if needed?
    // User said "auto generate... uptil available".
    // If we are appending new days, we usually don't need to re-fetch old ones unless corrected.
    // BUT, if it returns 200, we overwrite. If 404, we stop.

    console.log(`Checking ${dateStr} at ${targetUrl} (source: ${resolved.source || 'unknown'})...`);

    try {
        const html = resolved.html ? resolved.html : (await axios.get(targetUrl)).data;
        const $ = cheerio.load(html);

        // Pre-processing
        $('br').replaceWith('\n');
        $('div, p').after('\n');

        const postBody = $('.post-body, #post-body').first();
        if (!postBody.length) {
            console.warn(`No #post-body found for ${targetUrl}`);
            return false; // Treat as failure/stop? Or just skip?
        }

        const rawText = postBody.text();
        const lines = rawText.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);

        const isMarathi = (text) => /[\u0900-\u097F]/.test(text);
        const marathiLines = lines.filter(line => isMarathi(line));

        let currentSection = null;
        let sections = {
            firstReading: [],
            psalm: [],
            alleluia: [],
            gospel: []
        };

        for (const line of marathiLines) {
            if (line.includes('चिंतन') && sections.gospel.length > 0) {
                break;
            }

            if (line.includes('पहिले वाचन')) {
                currentSection = 'firstReading';
                sections[currentSection].push(line);
            } else if (line.trim().startsWith('प्रतिसाद')) {
                currentSection = 'psalm';
                sections[currentSection].push(line);
            } else if (line.includes('जयघोष') || line.includes('आल्लेलूया') || line.includes('आलेलुया')) {
                if (!['firstReading', 'psalm', 'gospel'].includes(currentSection) || currentSection === 'psalm') {
                    currentSection = 'alleluia';
                }
                sections[currentSection] && sections[currentSection].push(line);
            } else if (line.includes('शुभवर्तमान') && line.length < 100) {
                currentSection = 'gospel';
                sections[currentSection].push(line);
            } else {
                if (currentSection) {
                    sections[currentSection].push(line);
                }
            }
        }

        const firstReadingContent = parseSection(sections.firstReading);
        const psalmContent = parseSection(sections.psalm);
        const alleluiaContent = {
            type: "Alleluia",
            heading: sections.alleluia[0] || "Alleluia",
            reference: "",
            verses: sections.alleluia.slice(1)
        };
        const gospelContent = parseSection(sections.gospel);

        const outputData = {
            date: dateStr,
            url: targetUrl,
            title: "Marathi Bible Reading",
            feast: "",
            readings: [
                {
                    type: "First Reading",
                    heading: firstReadingContent.heading,
                    reference: firstReadingContent.reference,
                    verses: firstReadingContent.verses,
                    acclamation: firstReadingContent.acclamation,
                    response: firstReadingContent.response
                },
                {
                    type: "Responsorial Psalm",
                    heading: psalmContent.heading,
                    reference: psalmContent.reference,
                    verses: psalmContent.verses
                },
                {
                    type: "Alleluia",
                    heading: alleluiaContent.heading,
                    reference: alleluiaContent.reference,
                    verses: alleluiaContent.verses
                },
                {
                    type: "Gospel",
                    heading: gospelContent.heading || "Gospel",
                    reference: gospelContent.reference,
                    verses: gospelContent.verses,
                    acclamation: gospelContent.acclamation,
                    response: gospelContent.response
                }
            ]
        };

        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
        console.log(`Saved: ${outputFile}`);
        return true;

    } catch (err) {
        if (err.response && err.response.status === 404) {
            console.log(`404 Not Found for ${targetUrl}. Stopping.`);
            return false;
        }
        console.error(`Error processing ${targetUrl}:`, err.message);
        return false; // Stop on error too? Or assume temporary glitch? 
        // For "uptil available", error usually means end.
    }
}

function parseSection(lines) {
    if (!lines || lines.length === 0) return { heading: "", reference: "", verses: [] };
    const heading = lines[0];
    let reference = heading;
    let verses = lines.slice(1);
    let acclamation = null;
    let response = null;

    let filteredVerses = [];
    for (let i = 0; i < verses.length; i++) {
        const line = verses[i];
        if (line.includes('प्रभूचा शब्द') || line.includes('प्रभूचे हे शुभवर्तमान')) {
            acclamation = line;
        } else if (line.includes('देवाला धन्यवाद') || line.includes('तुझी स्तुती असो')) {
            response = line;
        } else {
            filteredVerses.push(line);
        }
    }
    return { heading, reference, verses: filteredVerses, acclamation, response };
}

async function main() {
    // Determine base paths
    // Current script: testing/marathireadings/loopfetch.js
    // Target content: content/readings-marathi
    const contentDir = path.resolve(__dirname, '../content/readings-marathi');

    // Find where to start
    let cursorDate = getLastProcessedDate(contentDir);

    // If we found a date (e.g. 14th), we want to start trying the 15th.
    // If getLastProcessedDate returns Today (and it wasn't a file), we start from Today.
    // Logic: Default Last Date is set to TODAY (00:00). 
    // If getLastProcessedDate actually found a file, it returns that specific date.
    // In ALL cases, we want to try (LastDate + 1 Day).
    // Wait, if getLastProcessedDate returns Today because no files exist, we should start with Today? 
    // No, if no files exist, we might want to start fetching Today.
    // So if (LastDate == Today and No File), we want Today.
    // If (LastDate == Yesterday file), we want Today.

    // Let's simplify: Start form Current Date we assume is safe to fetch or "Next" date.
    // If we have 14th, we try 15th.
    // If we have nothing, we try Today.

    // To distinguish "Found Nothing" from "Found Today", let's adjust logic slightly or just use:
    // If cursorDate is found from file, add 1 day.
    // If cursorDate is "Today" default, we start from "Today".

    // Check if file for cursorDate exists?
    const cursorY = cursorDate.getFullYear();
    const cursorM = String(cursorDate.getMonth() + 1).padStart(2, '0');
    const cursorD = String(cursorDate.getDate()).padStart(2, '0');
    const checkPath = path.join(contentDir, String(cursorY), cursorM, `${cursorY}-${cursorM}-${cursorD}.json`);

    if (fs.existsSync(checkPath)) {
        // File exists, move to next day
        cursorDate.setDate(cursorDate.getDate() + 1);
    }

    console.log(`Starting loop from ${cursorDate.toDateString()}...`);

    let keepGoing = true;
    let sanityLimit = 30; // Max 30 days ahead to prevent infinite loops if 404s aren't caught or weird redirects
    let count = 0;

    while (keepGoing && count < sanityLimit) {
        keepGoing = await fetchAndSave(new Date(cursorDate), contentDir);
        if (keepGoing) {
            cursorDate.setDate(cursorDate.getDate() + 1);
            count++;
            await delay(1000); // 1 sec delay
        }
    }

    console.log("Done.");
}

main();
