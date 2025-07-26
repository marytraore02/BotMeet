// Import des modules nécessaires
const { spawn, fork } = require('child_process');
const os = require('os');
const fs = require("fs");
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const cors = require('cors');

// Importation de la logique Puppeteer (gardée séparée pour la clarté)
const { launch, getStream, wss: puppeteerWss } = require("puppeteer-stream"); 
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');

// Configuration des plugins Puppeteer
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true, useCache: false }));
puppeteer.use(AnonymizeUAPlugin());

// --- CONFIGURATION DU SERVEUR WEB ET WEBSOCKET ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Pour servir notre fichier index.html

// Stocker les connexions WebSocket actives
const clients = new Set();

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('Client connecté au WebSocket');
    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client déconnecté');
    });
});

// Fonction pour envoyer des messages à tous les clients connectés
function broadcast(message) {
    console.log("BROADCAST:", message.message); // Log serveur
    for (const client of clients) {
        if (client.readyState === 1) { // 1 = WebSocket.OPEN
            client.send(JSON.stringify(message));
        }
    }
}

// --- ENDPOINT API POUR DÉMARRER L'ENREGISTREMENT ---
app.post('/start-recording', (req, res) => {
    const { meetLink, durationInHours } = req.body;

    if (!meetLink || !durationInHours) {
        return res.status(400).json({ error: 'Lien Meet et durée sont requis.' });
    }

    // Valider le lien Meet (simple validation)
    if (!meetLink.startsWith('https://meet.google.com/')) {
         return res.status(400).json({ error: 'Le lien Meet semble invalide.' });
    }

    console.log(`Requête reçue: ${meetLink}, Durée: ${durationInHours}h`);
    
    // On lance le bot en arrière-plan sans attendre la fin de la fonction
    runMeetBot(meetLink, durationInHours).catch(err => {
        console.error("Erreur non capturée dans runMeetBot:", err);
        broadcast({ type: 'error', message: `❌ Erreur critique inattendue: ${err.message}` });
    });

    res.status(200).json({ message: 'Processus de recording démarré.' });
});

// app.post('/stop-recording', async (req, res) => {
//     if (!activeProcess.isRunning) {
//         return res.status(404).json({ error: 'Aucun processus à arrêter.' });
//     }
//     await activeProcess.stop({ isSuccess: false });
//     res.status(200).json({ message: 'Demande d\'arrêt envoyée.' });
// });
// --- LOGIQUE DU BOT (ADAPTÉE DE VOTRE SCRIPT) ---

// Fonction principale du bot, maintenant paramétrable
async function runMeetBot(meetLink, durationInHours) {
    // Configuration
    const AGENT_NAME = `Agent-${Math.floor(Math.random() * 1000)}`;
    const RECORDING_DURATION_MS = durationInHours * 60 * 60 * 1000;
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 5000;
    const MAX_REFRESH_PER_ATTEMPT = 3;
    let ffmpegProcess;
    let browser;

    // Sélecteurs robustes
    const SELECTORS = {
        EMAIL_INPUT: 'input[type="email"], input[name="identifier"], #identifierId',
        PASSWORD_INPUT: 'input[type="password"], input[name="password"], #password',
        NEXT_BUTTON: '#identifierNext, button[type="submit"]',
        PASSWORD_NEXT: '#passwordNext, button[type="submit"]',
        NAME_INPUT: 'input[placeholder*="Votre nom"], input[placeholder*="name"], input[aria-label*="nom"]',
        JOIN_BUTTON: '[data-call-to-action="join"], button[jsname="Qx7uuf"]',
        LEAVE_BUTTON: '[data-call-to-action="leave"],button[aria-label*="Quitter"], button[aria-label*="Leave call"]'
    };
    
    // Fonction pour délais aléatoires
    const randomDelay = (min = 1000, max = 3000) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
    
    // Fonction pour typing humain-like
    async function humanTypeText(page, selector, text) {
        await page.waitForSelector(selector);
        await page.click(selector);
        await randomDelay(500, 1500);
        for (const char of text) {
            await page.keyboard.type(char, { delay: Math.random() * 100 + 50 });
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
                    await page.goto(meetLink, { waitUntil: 'networkidle2', timeout: 30000 });
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
                    await page.goto(meetLink, { waitUntil: 'networkidle2', timeout: 30000 });
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
        broadcast({ type: 'status', message: `🔴 Démarrage de l'enregistrement FFmpeg vers ${fileName}` });
        
        let ffmpegArgs = [];
        const platform = os.platform();
        
        if (platform === 'win32') {
            ffmpegArgs = ['-f', 'dshow', '-i', 'audio=Stereo Mix (Realtek(R) Audio)', '-acodec', 'libmp3lame', '-q:a', '2', fileName];
        } else if (platform === 'darwin') {
            ffmpegArgs = ['-f', 'avfoundation', '-i', ':1', '-acodec', 'libmp3lame', fileName];
        } else {
            ffmpegArgs = ['-f', 'pulse', '-i', 'default', '-acodec', 'libmp3lame', fileName];
        }
        
        ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
        
        ffmpegProcess.stderr.on('data', (data) => console.error(`ffmpeg stderr: ${data.toString()}`));
        ffmpegProcess.on('close', (code) => broadcast({ type: 'status', message: `✅ Enregistrement FFmpeg terminé (code ${code}).`}));
    }

    function stopRecordingWithFFmpeg() {
        return new Promise((resolve) => {
            if (!ffmpegProcess || ffmpegProcess.killed) return resolve();
            broadcast({ type: 'status', message: '⏹️ Arrêt de l\'enregistrement FFmpeg...' });
            ffmpegProcess.kill('SIGINT');
            ffmpegProcess.on('close', resolve);
        });
    }

    // function stopRecordingWithFFmpeg() {
    //     return new Promise((resolve) => {
    //         if (!ffmpegProcess) return resolve();
    //         ffmpegProcess.on('close', (code) => {
    //             // console.log(`✅ Enregistrement FFmpeg terminé avec le code ${code}.`);
    //             broadcast({ type: 'status', message: `⏹️ Arrêt de l\'enregistrement FFmpeg avec le code ${code}.` });
    //             resolve();
    //         });
    //         ffmpegProcess.kill('SIGINT');
    //     });
    // }

    try {
        // Détection Chrome
        let chromePath = '';
        const platform = os.platform();
        if (platform === 'darwin') {
            chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        } else if (platform === 'win32') {
            const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', `${os.homedir()}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`];
            chromePath = paths.find(p => fs.existsSync(p));
        } else {
            chromePath = '/usr/bin/google-chrome';
        }

        broadcast({ type: 'status', message: '🚀 Lancement du navigateur...' });
        browser = await launch({
            executablePath: chromePath,
            headless: false, // Mettez `true` pour une exécution sans interface graphique
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
        const origin = new URL(meetLink).origin;
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

        broadcast({ type: 'status', message: '👤 Connexion en mode invité...' });

        // ===== CONNEXION AVEC DÉTECTION DE CHARGEMENT ET RETRY =====
        const refreshStrategies = ['reload', 'goto', 'hard_reload', 'new_navigation'];
        let connected = false;
        
        for (let attempt = 1; attempt <= MAX_RETRIES && !connected; attempt++) {
            broadcast({ type: 'status', message: `\n▶️ Tentative de connexion n°${attempt}/${MAX_RETRIES}...` });
            try {
                // Première navigation
                broadcast({ type: 'status', message: `- 📡 Navigation vers le lien Meet...` });
                await page.goto(meetLink, {
                    waitUntil: 'networkidle2',
                     timeout: 15000 
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
                            console.log('   - ✅ Caméra .');
                        }
                    });
                });
                broadcast({ type: 'status', message: '🎤 Caméra et micro désactivés.' });
                await randomDelay(1000, 3000);

                // Gestion nom utilisateur invité
                try {
                    const nameInput = await page.waitForSelector(SELECTORS.NAME_INPUT, { timeout: 5000 });
                    await humanTypeText(page, SELECTORS.NAME_INPUT, AGENT_NAME);
                    broadcast({ type: 'status', message: `🏷️ Nom d'invité configuré: ${AGENT_NAME}` });
                    await randomDelay(1000, 2000);
                } catch (e) {
                    broadcast({ type: 'warning', message: "⚠️ Champ nom non trouvé, tentative de connexion directe..." });
                }
                
                // Cliquer sur "Participer"
                // const joinButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Participer")] or .//span[contains(text(), "Passer")] or .//span[contains(text(), "Join"])', { timeout: 10000 });
                const joinButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Participer")] or .//span[contains(text(), "Passer")]])', { timeout: 10000 });
                await joinButton.click();

                // // --- NOUVELLE LOGIQUE D'ATTENTE D'ADMISSION ---
                // broadcast({ type: 'status', message: '🚪 Demande de participation envoyée. En attente d\'admission...' });

                // const admissionTimeout = 300000; // 5 minutes d'attente max
                // const checkInterval = 5000; // Vérifier toutes les 5 secondes
                // let waitingTime = 0;
                // let admitted = false;

                // while (waitingTime < admissionTimeout) {
                //     // Essayer de trouver le bouton pour quitter (signe de succès)
                //     const leaveButton = await page.$(SELECTORS.LEAVE_BUTTON);
                //     if (leaveButton) {
                //         admitted = true;
                //         break; // Sortir de la boucle, on est entré
                //     }

                //     // Si on n'est pas admis, attendre et réessayer
                //     await new Promise(resolve => setTimeout(resolve, checkInterval));
                //     waitingTime += checkInterval;
                //     broadcast({ type: 'status', message: `...en attente depuis ${Math.round(waitingTime / 1000)}s...` });
                // }

                // if (admitted) {
                //     broadcast({ type: 'success', message: '✅ Admission à la réunion réussie !' });
                //     connected = true;
                // } else {
                //     throw new Error(`Admission non accordée après ${admissionTimeout / 60000} minutes.`);
                // }
                // // --- FIN DE LA NOUVELLE LOGIQUE ---
                
                await page.waitForSelector(SELECTORS.LEAVE_BUTTON, { timeout: 15000 });
                broadcast({ type: 'success', message: '✅ Connexion à la réunion réussie !' });
                connected = true;

            } catch (e) {
                broadcast({ type: 'error', message: `❌ Échec de la tentative ${attempt}: ${e.message.split('\n')[0]}` });
                if (attempt < MAX_RETRIES) {
                    await randomDelay(RETRY_DELAY_MS);
                } else {
                   throw new Error(`Échec de la connexion après ${MAX_RETRIES} tentatives.`);
                }
            }
        }

        if (!connected) return; // Arrête si la connexion a échoué

        // ENREGISTREMENT
        const recordingsFolder = 'recordings';
        if (!fs.existsSync(recordingsFolder)) fs.mkdirSync(recordingsFolder);

        const filePath = `${recordingsFolder}/meeting-${Date.now()}.mp3`;
        startRecordingWithFFmpeg(filePath);
        broadcast({ type: 'status', message: `🔊 Enregistrement en cours pour ${durationInHours} heure(s)...` });
        
        await new Promise(resolve => setTimeout(resolve, RECORDING_DURATION_MS));
        
        stopRecordingWithFFmpeg();
        broadcast({ type: 'status', message: `Le fichier a été sauvegardé sous "${filePath}".` });

        // Lancement du worker pour l'upload
        broadcast({ type: 'status', message: '🚀 Lancement du worker pour l\'envoi du fichier...' });
        const worker = fork('./upload-worker.js', [filePath], { detached: true, stdio: 'ignore' });
        worker.unref();

        broadcast({ type: 'finished', message: '🎉 Processus terminé avec succès ! Le worker d\'upload s\'exécute en arrière-plan.' });

    } catch (error) {
        broadcast({ type: 'error', message: `❌ Erreur critique: ${error.message}` });
    } finally {
        if (browser) await browser.close();
        if (puppeteerWss) (await puppeteerWss).close();
        broadcast({ type: 'status', message: 'Navigateur fermé.' });
    }
}


// Démarrage du serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    console.log('Ouvrez public/index.html dans votre navigateur.');
});
