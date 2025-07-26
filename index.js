// Import des modules nécessaires
const { spawn, fork } = require('child_process');
const os = require('os');
const { launch, getStream, wss } = require("puppeteer-stream"); 
// import puppeteer from 'puppeteer';
const fs = require("fs");
const axios = require('axios');
const FormData = require('form-data');

// Configuration Puppeteer-extra améliorée
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');

// Configuration plugins avec options avancées
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ 
    blockTrackers: true,
    useCache: false // Évite les patterns de cache suspects
}));
puppeteer.use(AnonymizeUAPlugin());

// Configuration sécurisée
const AGENT_NAME = `Agent-${Math.floor(Math.random() * 1000)}`;
const MEETING_LINK = process.argv[2];
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL;
const GOOGLE_PASSWORD = process.env.GOOGLE_PASSWORD;
const RECORDING_DURATION_MS = parseInt(process.env.RECORDING_DURATION_MS) || 22000;
const MAX_RETRIES = 5; // Augmenté pour tenir compte des rafraîchissements
const RETRY_DELAY_MS = 5000;
const MAX_REFRESH_PER_ATTEMPT = 3;

// Sélecteurs plus robustes (CSS + fallback)
const SELECTORS = {
    EMAIL_INPUT: 'input[type="email"], input[name="identifier"], #identifierId',
    PASSWORD_INPUT: 'input[type="password"], input[name="password"], #password',
    NEXT_BUTTON: '#identifierNext, button[type="submit"]',
    PASSWORD_NEXT: '#passwordNext, button[type="submit"]',
    NAME_INPUT: 'input[placeholder*="Votre nom"], input[placeholder*="name"], input[aria-label*="nom"]',
    JOIN_BUTTON: '[data-call-to-action="join"], button[jsname="Qx7uuf"]',
    LEAVE_BUTTON: '[data-call-to-action="leave"],button[aria-label*="Quitter"], button[aria-label*="Leave call"]'
};

if (!MEETING_LINK) {
    console.error('❌ Erreur : Veuillez fournir un lien de réunion Google Meet.');
    console.log('Usage: node join-meet.js <lien_de_la_reunion>');
    process.exit(1);
}

let ffmpegProcess;

// Fonction pour délais aléatoires (anti-détection)
function randomDelay(min = 1000, max = 3000) {
    return new Promise(resolve => {
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        setTimeout(resolve, delay);
    });
}

// Fonction pour typing humain-like
async function humanTypeText(page, selector, text) {
    await page.waitForSelector(selector);
    await page.click(selector);
    await randomDelay(500, 1500);
    
    for (let i = 0; i < text.length; i++) {
        await page.keyboard.type(text[i]);
        await randomDelay(50, 150);
    }
}

// Fonction pour vérifier si la page Meet s'est bien chargée
async function checkPageLoadSuccess(page) {
    const checks = [
        // Vérifier la présence d'éléments essentiels de Google Meet
        () => page.$('[data-meeting-title], [jsname="r4nke"], .google-material-icons'),
        
        // Vérifier que le DOM contient des éléments Meet spécifiques
        () => page.evaluate(() => {
            const indicators = [
                document.querySelector('[role="main"]'),
                document.querySelector('[data-call-to-action]'),
                document.querySelector('input[placeholder*="nom"], input[placeholder*="name"]'),
                document.title.toLowerCase().includes('meet'),
                window.location.href.includes('meet.google.com')
            ];
            return indicators.some(indicator => indicator);
        }),
        
        // Vérifier les ressources réseau critiques
        () => page.evaluate(() => {
            return window.performance && 
                   window.performance.navigation.type !== 2 &&
                   document.readyState === 'complete';
        }),
        
        // Vérifier l'absence d'erreurs de chargement
        () => page.evaluate(() => {
            const errorTexts = ['error', 'erreur', 'impossible', 'failed', 'échec'];
            const bodyText = document.body?.textContent?.toLowerCase() || '';
            return !errorTexts.some(error => bodyText.includes(error));
        })
    ];
    
    try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const results = await Promise.all(checks.map(check => check().catch(() => false)));
        const successCount = results.filter(Boolean).length;
        console.log(`   - Vérifications de chargement: ${successCount}/${checks.length} réussies`);
        
        return successCount >= 2;
        
    } catch (error) {
        console.error('   - Erreur lors de la vérification du chargement:', error.message);
        return false;
    }
}

// Fonction pour rafraîchir la page avec stratégies multiples
async function refreshPageWithStrategy(page, strategy = 'reload') {
    console.log(`   - 🔄 Rafraîchissement avec stratégie: ${strategy}`);
    
    try {
        switch (strategy) {
            case 'reload':
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
                break;
                
            case 'goto':
                await page.goto(MEETING_LINK, { waitUntil: 'networkidle2', timeout: 30000 });
                break;
                
            case 'hard_reload':
                await page.evaluate(() => window.location.reload(true));
                await page.waitForLoadState?.('networkidle', { timeout: 30000 }).catch(() => {
                    return new Promise(resolve => setTimeout(resolve, 5000));
                });
                break;
                
            case 'new_navigation':
                await page.goto('about:blank');
                await randomDelay(1000, 2000);
                await page.goto(MEETING_LINK, { waitUntil: 'networkidle2', timeout: 30000 });
                break;
                
            default:
                await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        }
        
        await randomDelay(2000, 4000);
        return true;
        
    } catch (error) {
        console.error(`   - ❌ Échec du rafraîchissement (${strategy}):`, error.message);
        return false;
    }
}

// Fonction pour détecter et gérer les popups
async function handlePopups(page) {
    const popupHandlers = [
        {
            name: 'Notifications',
            selectors: ['button[jsname="V67aGc"]', 'button:has-text("Pas maintenant")', 'button:has-text("Not now")'],
            action: 'click'
        },
        {
            name: 'Continue call',
            selectors: ['button:has-text("OK")', 'button:has-text("Continuer")'],
            action: 'click'
        }
    ];
    
    for (const handler of popupHandlers) {
        for (const selector of handler.selectors) {
            try {
                const element = await page.waitForSelector(selector, { timeout: 2000 });
                if (element) {
                    console.log(`🖱️ Popup "${handler.name}" détecté et fermé.`);
                    await element.click();
                    await randomDelay(1000, 2000);
                    break;
                }
            } catch (e) {
                // Popup non trouvé, continue
            }
        }
    }
}

function startRecordingWithFFmpeg(fileName) {
    console.log(`🔴 Démarrage de l'enregistrement avec FFmpeg... Fichier : ${fileName}`);
    
    let ffmpegArgs = [];
    const platform = os.platform();
    
    if (platform === 'win32') {
        ffmpegArgs = [
            '-f', 'dshow',
            '-i', 'audio=Stereo Mix (Realtek(R) Audio)',
            '-acodec', 'libmp3lame',
            '-q:a', '2',
            fileName
        ];
    } else if (platform === 'darwin') {
        ffmpegArgs = [
            '-f', 'avfoundation',
            '-i', ':1',
            '-acodec', 'libmp3lame',
            fileName
        ];
    } else {
        ffmpegArgs = [
            '-f', 'pulse',
            '-i', 'default',
            '-acodec', 'libmp3lame',
            fileName
        ];
    }
    
    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
    
    ffmpegProcess.stdout.on('data', (data) => console.log(`ffmpeg: ${data}`));
    ffmpegProcess.stderr.on('data', (data) => console.error(`ffmpeg stderr: ${data.toString()}`));
}

function stopRecordingWithFFmpeg() {
    return new Promise((resolve) => {
        if (!ffmpegProcess) return resolve();
        
        ffmpegProcess.on('close', (code) => {
            console.log(`✅ Enregistrement FFmpeg terminé avec le code ${code}.`);
            resolve();
        });
        
        console.log('Signal d\'arrêt envoyé à FFmpeg...');
        ffmpegProcess.kill('SIGINT');
    });
}

(async () => {
    // Détection Chrome améliorée
    let chromePath = '';
    const platform = os.platform();
    
    if (platform === 'darwin') {
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else if (platform === 'win32') {
        const paths = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${os.homedir()}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`
        ];
        chromePath = paths.find(p => fs.existsSync(p));
    } else {
        chromePath = '/usr/bin/google-chrome';
    }
    
    if (chromePath && !fs.existsSync(chromePath)) {
        console.warn(`⚠️ Chrome non trouvé à : ${chromePath}`);
        chromePath = null;
    }
    
    console.log(`🚀 Lancement du navigateur... (${chromePath ? 'Google Chrome' : 'Chromium par défaut'})`);
    
    let browser;
    
    try {
        // Configuration browser anti-détection améliorée
        browser = await launch({
            executablePath: chromePath,
            headless: false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-features=VizDisplayCompositor',
                '--window-size=1920,1080',
                '--disable-web-security',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-background-timer-throttling',
                '--disable-renderer-backgrounding',
                '--disable-backgrounding-occluded-windows',
                '--disable-extensions',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            ]
        });
        
        // Masquer les propriétés webdriver
        const context = browser.defaultBrowserContext();
        const origin = new URL(MEETING_LINK).origin;
        await context.overridePermissions(origin, ['microphone', 'camera', 'notifications']);
        console.log(`✅ Permissions accordées pour l'origine : ${origin}`);
        
        const page = await browser.newPage();
        
        // Scripts anti-détection avancés
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => false,
            });
            
            delete navigator.__proto__.webdriver;
            
            Object.defineProperty(navigator, 'languages', {
                get: () => ['en-US', 'en', 'fr'],
            });
            
            Object.defineProperty(navigator, 'plugins', {
                get: () => [
                    { name: 'Chrome PDF Plugin', length: 1 },
                    { name: 'Chrome PDF Viewer', length: 1 },
                    { name: 'Native Client', length: 1 }
                ],
            });
        });
        
        // User-Agent rotatif
        const userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ];
        await page.setUserAgent(userAgents[Math.floor(Math.random() * userAgents.length)]);
        page.setDefaultTimeout(45000);

        console.log('👤 Connexion en mode invité anonyme (plus sûr et stable)...');
        
        // ===== CONNEXION AVEC DÉTECTION DE CHARGEMENT ET RETRY =====
        const refreshStrategies = ['reload', 'goto', 'hard_reload', 'new_navigation'];
        let connected = false;
        
        for (let attempt = 1; attempt <= MAX_RETRIES && !connected; attempt++) {
            console.log(`\n▶️ Tentative de connexion n°${attempt}/${MAX_RETRIES}...`);
            
            try {
                // Première navigation
                console.log('   - 📡 Navigation vers le lien Meet...');
                await page.goto(MEETING_LINK, { 
                    waitUntil: 'networkidle2',
                    timeout: 30000 
                });
                
                // Vérifier le chargement initial
                const initialLoadSuccess = await checkPageLoadSuccess(page);
                
                if (!initialLoadSuccess) {
                    console.warn('   - ⚠️ Chargement initial défaillant, tentatives de rafraîchissement...');
                    
                    // Tenter plusieurs rafraîchissements avec différentes stratégies
                    let refreshSuccess = false;
                    
                    for (let refreshAttempt = 1; refreshAttempt <= MAX_REFRESH_PER_ATTEMPT; refreshAttempt++) {
                        const strategy = refreshStrategies[(refreshAttempt - 1) % refreshStrategies.length];
                        
                        console.log(`   - 🔄 Rafraîchissement ${refreshAttempt}/${MAX_REFRESH_PER_ATTEMPT} (${strategy})`);
                        
                        const refreshResult = await refreshPageWithStrategy(page, strategy);
                        if (refreshResult) {
                            const loadCheckAfterRefresh = await checkPageLoadSuccess(page);
                            if (loadCheckAfterRefresh) {
                                console.log('   - ✅ Page chargée avec succès après rafraîchissement !');
                                refreshSuccess = true;
                                break;
                            }
                        }
                        
                        // Attendre avant le prochain rafraîchissement
                        if (refreshAttempt < MAX_REFRESH_PER_ATTEMPT) {
                            await randomDelay(2000, 4000);
                        }
                    }
                    
                    if (!refreshSuccess) {
                        console.error('   - ❌ Tous les rafraîchissements ont échoué pour cette tentative');
                        continue; // Passer à la tentative suivante
                    }
                } else {
                    console.log('   - ✅ Page chargée correctement dès la première navigation');
                }
                
                // Continuer avec la logique de connexion normale
                await randomDelay(3000, 6000);
                // await new Promise(resolve => setTimeout(resolve, 6000));
                await handlePopups(page);
                
                // Désactiver micro/caméra avec délais aléatoires
                await page.evaluate(() => {
                    const buttons = document.querySelectorAll('[role="button"]');
                    buttons.forEach(button => {
                        const label = button.getAttribute('aria-label') || '';
                        if (label.toLowerCase().includes('microphone') || label.toLowerCase().includes('micro')) {
                            button.click();
                            console.log('   - ✅ Microphone désactivé.');
                        }
                        if (label.toLowerCase().includes('camera') || label.toLowerCase().includes('caméra')) {
                            button.click();
                            console.log('   - ✅ Caméra désactivée.');
                        }
                    });
                });
                
                await randomDelay(1000, 3000);
                
                // Gestion nom utilisateur invité
                try {
                    const nameInput = await page.waitForSelector(SELECTORS.NAME_INPUT, { timeout: 5000 });
                    await humanTypeText(page, SELECTORS.NAME_INPUT, AGENT_NAME);
                    await randomDelay(1000, 2000);
                    console.log(`   - ✅ Nom d'invité configuré: ${AGENT_NAME}`);
                } catch (e) {
                    console.log("   - ⚠️ Champ nom non trouvé, tentative de connexion directe...");
                }
                
                // Rejoindre avec sélecteur robuste
                try {
                    const joinButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Participer")] or .//span[contains(text(), "Passer")]])', { timeout: 10000 });
                    await joinButton.click();
                    
                    // Vérification connexion
                    await page.waitForSelector(SELECTORS.LEAVE_BUTTON, { timeout: 15000 });
                    console.log('   - ✅ Connexion à la réunion réussie !');
                    connected = true;
                    
                } catch (joinError) {
                    console.error(`   - ❌ Erreur lors de la tentative de connexion: ${joinError.message}`);
                    
                    // Prendre une capture d'écran pour debug
                    try {
                        await page.screenshot({ path: `debug-attempt-${attempt}.png` });
                        console.log(`   - 📸 Capture d'écran sauvegardée: debug-attempt-${attempt}.png`);
                    } catch (screenshotError) {
                        console.warn('   - ⚠️ Impossible de prendre une capture d\'écran');
                    }
                }
                
            } catch (navigationError) {
                console.error(`   - ❌ Erreur de navigation (tentative ${attempt}): ${navigationError.message}`);
            }
            
            // Attendre avant la prochaine tentative
            if (!connected && attempt < MAX_RETRIES) {
                const waitTime = RETRY_DELAY_MS + (attempt * 1000); // Délai progressif
                console.log(`   - ⏳ Attente de ${waitTime/1000}s avant la prochaine tentative...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
        
        if (!connected) {
            throw new Error(`Échec de la connexion après ${MAX_RETRIES} tentatives avec rafraîchissements`);
        }
        
        // ENREGISTREMENT
        console.log('🎵 Préparation de l\'enregistrement...');
        await randomDelay(3000, 5000);
        
        const recordingsFolder = 'recordings';
        if (!fs.existsSync(recordingsFolder)) {
            fs.mkdirSync(recordingsFolder);
        }
        
        const filePath = `${recordingsFolder}/meeting-${Date.now()}.mp3`;
        startRecordingWithFFmpeg(filePath);
        
        console.log(`🔊 Enregistrement: ${RECORDING_DURATION_MS/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, RECORDING_DURATION_MS));
        
        stopRecordingWithFFmpeg();
        console.log(`Le fichier sera sauvegardé sous "${filePath}".`);
        
        console.log('🚀 Lancement du worker en arrière-plan pour l\'envoi du fichier...'); 
        // Worker en arrière-plan
        const worker = fork('./upload-worker.js', [filePath], {
            detached: true,
            stdio: 'ignore'
        });
        worker.unref();

        console.log("👋 Le script principal a terminé sa tâche. Le worker continue en arrière-plan.");
        
        // Sortie propre
        try {
            const leaveButton = await page.$('button[aria-label*="Quitter"]');
            if (leaveButton) {
                await leaveButton.click();
                await randomDelay(1000, 2000);
            }
        } catch (e) {
            console.warn("⚠️ Impossible de quitter proprement.");
        }
        
        await browser.close();
        if (wss) (await wss).close();
        
        console.log("✅ Terminé avec succès !");
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Erreur critique:', error.message);
        
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    await pages[0].screenshot({ path: 'error.png' });
                }
                await browser.close();
            } catch (e) {
                console.error("Erreur lors de la fermeture:", e.message);
            }
        }
        
        if (wss) {
            try {
                (await wss).close();
            } catch (e) {
                console.error("Erreur websocket:", e.message);
            }
        }
        
        process.exit(1);
    }
})();