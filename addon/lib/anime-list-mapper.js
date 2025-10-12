const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const { redis } = require('./getCache');
const xml2js = require('xml2js');

// Anime-Lists XML file URL
const REMOTE_ANIME_LIST_URL = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/refs/heads/master/anime-list-full.xml';
const LOCAL_CACHE_PATH = path.join('/tmp', 'addon', 'data', 'anime-list-full.xml.cache'); // changed here
const REDIS_ETAG_KEY = 'anime-list-xml-etag';
const UPDATE_INTERVAL_HOURS = parseInt(process.env.ANIME_LIST_XML_UPDATE_INTERVAL_HOURS) || 24; // Update every 24 hours (configurable)

// Data structures to hold parsed mappings
let animeListMap = new Map(); // anidbid -> anime entry
let tvdbToAnimeMap = new Map(); // tvdbid -> array of anime entries
let tmdbToAnimeMap = new Map(); // tmdbid -> array of anime entries
let imdbToAnimeMap = new Map(); // imdbid -> array of anime entries
let isInitialized = false;
let updateInterval = null;

/**
 * Parses the XML data and builds indexed maps for fast lookups
 */
function processAndIndexXmlData(xmlData) {
  animeListMap.clear();
  tvdbToAnimeMap.clear();
  tmdbToAnimeMap.clear();
  imdbToAnimeMap.clear();

  const parser = new xml2js.Parser({ explicitArray: true });
  
  return new Promise((resolve, reject) => {
    parser.parseString(xmlData, (err, result) => {
      if (err) {
        reject(err);
        return;
      }

      try {
        const animeList = result['anime-list'].anime || [];
        
        for (const anime of animeList) {
          const anidbid = parseInt(anime.$.anidbid);
          if (!anidbid) continue;

          // Store by AniDB ID
          animeListMap.set(anidbid, anime);

          // Index by TVDB ID
          if (anime.$.tvdbid && anime.$.tvdbid !== 'unknown' && anime.$.tvdbid !== 'hentai') {
            const tvdbId = parseInt(anime.$.tvdbid);
            if (!tvdbToAnimeMap.has(tvdbId)) {
              tvdbToAnimeMap.set(tvdbId, []);
            }
            tvdbToAnimeMap.get(tvdbId).push(anime);
          }

          // Index by TMDB TV ID
          if (anime.$.tmdbtv) {
            const tmdbId = parseInt(anime.$.tmdbtv);
            if (!tmdbToAnimeMap.has(tmdbId)) {
              tmdbToAnimeMap.set(tmdbId, []);
            }
            tmdbToAnimeMap.get(tmdbId).push(anime);
          }

          // Index by IMDB ID
          if (anime.$.imdbid) {
            const imdbIds = anime.$.imdbid.split(',').map(id => id.trim());
            for (const imdbId of imdbIds) {
              if (imdbId && imdbId !== 'unknown') {
                if (!imdbToAnimeMap.has(imdbId)) {
                  imdbToAnimeMap.set(imdbId, []);
                }
                imdbToAnimeMap.get(imdbId).push(anime);
              }
            }
          }
        }

        isInitialized = true;
        console.log(`[Anime List Mapper] Successfully loaded and indexed ${animeListMap.size} anime mappings.`);
        console.log(`[Anime List Mapper] TVDB mappings: ${tvdbToAnimeMap.size}, TMDB mappings: ${tmdbToAnimeMap.size}, IMDB mappings: ${imdbToAnimeMap.size}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Downloads and processes the anime-list XML file
 */
async function downloadAndProcessAnimeList() {
  const useRedisCache = redis && redis.status === 'ready';

  try {
    if (useRedisCache) {
      try {
        const savedEtag = await redis.get(REDIS_ETAG_KEY);
        const headers = (await axios.head(REMOTE_ANIME_LIST_URL, { timeout: 10000 })).headers;
        const remoteEtag = headers.etag;

        console.log(`[Anime List Mapper] Saved ETag: ${savedEtag} | Remote ETag: ${remoteEtag}`);

        if (savedEtag && remoteEtag && savedEtag === remoteEtag) {
          try {
            console.log('[Anime List Mapper] No changes detected. Loading from local disk cache...');
            const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
            await processAndIndexXmlData(fileContent);
            return;
          } catch {
            console.warn('[Anime List Mapper] ETag matched, but local cache unreadable. Forcing re-download.');
          }
        }
      } catch (redisError) {
        console.warn('[Anime List Mapper] Redis error, proceeding without cache:', redisError.message);
      }
    }

    console.log('[Anime List Mapper] Downloading anime-list XML...');
    const response = await axios.get(REMOTE_ANIME_LIST_URL, { timeout: 60000 });
    const xmlData = response.data;

    await fs.mkdir(path.dirname(LOCAL_CACHE_PATH), { recursive: true });
    await fs.writeFile(LOCAL_CACHE_PATH, xmlData, 'utf-8');

    if (useRedisCache) {
      try {
        await redis.set(REDIS_ETAG_KEY, response.headers.etag);
      } catch (err) {
        console.warn('[Anime List Mapper] Failed to save ETag to Redis:', err.message);
      }
    }

    await processAndIndexXmlData(xmlData);
  } catch (error) {
    console.error(`[Anime List Mapper] Download failed: ${error.message}`);
    console.log('[Anime List Mapper] Attempting local fallback...');
    try {
      const fileContent = await fs.readFile(LOCAL_CACHE_PATH, 'utf-8');
      console.log('[Anime List Mapper] Loaded from local cache.');
      await processAndIndexXmlData(fileContent);
    } catch (fallbackError) {
      console.error('[Anime List Mapper] Fallback failed. Mapper will remain empty.');
    }
  }
}

async function initializeAnimeListMapper() {
  if (isInitialized) return;
  await downloadAndProcessAnimeList();
}

module.exports = {
  initializeAnimeListMapper,
  getAnimeByAnidbId: id => animeListMap.get(parseInt(id)) || null,
  getAnimeByTvdbId: id => tvdbToAnimeMap.get(parseInt(id)) || [],
  getAnimeByTmdbId: id => tmdbToAnimeMap.get(parseInt(id)) || [],
  getAnimeByImdbId: id => imdbToAnimeMap.get(id) || [],
  isInitialized: () => isInitialized
};
