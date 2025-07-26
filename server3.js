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

// --- GESTION D'ÉTAT DU PROCESSUS ACTIF ---
let activeProcess = {
    browser: null,
    ffmpeg: null,
    recordingTimer: null,
    isRunning: false,
    filePath: null,

    // Méthode unique pour arrêter proprement le processus en cours
    stop: async function(options = { isSuccess: false }) {
        if (!this.isRunning && !this.browser) return; // Empêche les appels multiples
        
        if (this.isRunning) {
            if (options.isSuccess) {
                broadcast({ type: 'status', message: '⌛ Durée d\'enregistrement atteinte.' });
            } else {
                broadcast({ type: 'warning', message: '🛑 Arrêt manuel ou suite à une erreur demandé...' });
            }
        }
        
        this.isRunning = false;

        if (this.recordingTimer) {
            clearTimeout(this.recordingTimer);
            this.recordingTimer = null;
        }

        // **CHANGEMENT CLÉ** : Arrêter FFmpeg de manière fiable
        if (this.ffmpeg && !this.ffmpeg.killed) {
            broadcast({ type: 'status', message: '⏹️ Envoi du signal d\'arrêt à FFmpeg...' });
            await new Promise((resolve) => {
                // Écouter l'événement 'close' pour savoir quand le processus est bien terminé
                this.ffmpeg.on('close', resolve);
                // Envoyer 'q' à stdin, la méthode officielle pour arrêter ffmpeg proprement
                this.ffmpeg.stdin.write('q');
                this.ffmpeg.stdin.end();
            });
            this.ffmpeg = null;
            broadcast({ type: 'status', message: '✅ Enregistrement FFmpeg terminé.' });
        }

        if (this.browser) {
            try {
                await this.browser.close();
                broadcast({ type: 'status', message: 'Navigateur fermé.' });
            } catch (e) {
                broadcast({ type: 'warning', message: `Impossible de fermer le navigateur proprement: ${e.message}` });
            }
            this.browser = null;
        }
        
        if (options.isSuccess && this.filePath) {
            broadcast({ type: 'status', message: `Le fichier a été sauvegardé sous "${this.filePath}".` });
            broadcast({ type: 'status', message: '🚀 Lancement du worker pour l\'envoi du fichier...' });
            const worker = fork('./upload-worker.js', [this.filePath], { detached: true, stdio: 'ignore' });
            worker.unref();
            broadcast({ type: 'finished', message: '🎉 Processus terminé avec succès ! Arrêt du serveur...' });
        } else {
            if (!options.isSuccess) {
                broadcast({ type: 'warning', message: '⚠️ L\'enregistrement n\'a pas abouti. Le worker d\'upload ne sera pas lancé.' });
            }
            broadcast({ type: 'finished', message: '⏹️ Processus interrompu. Arrêt du serveur...' });
            broadcast({ type: 'finished', message: '-----Vous pouvez rafraichir la page pour recommencer-----'});
        }

        this.filePath = null;

        setTimeout(() => {
            wss.close();
            server.close(() => {
                console.log('Serveur arrêté. Le processus va se terminer.');
                process.exit(0);
            });
        }, 2000);
    }
};

// --- ENDPOINT API POUR DÉMARRER L'ENREGISTREMENT ---
app.post('/start-recording', (req, res) => {
    if (activeProcess.isRunning) {
        return res.status(409).json({ error: 'Un processus est déjà en cours.' });
    }
    const { meetLink, durationInHours } = req.body;
    if (!meetLink || !durationInHours || !meetLink.startsWith('https://meet.google.com/')) {
        return res.status(400).json({ error: 'Données invalides.' });
    }

    console.log(`Requête reçue: ${meetLink}, Durée: ${durationInHours}h`);
    
    activeProcess.isRunning = true;
    runMeetBot(meetLink, durationInHours).catch(err => {
        console.error("Erreur non capturée dans runMeetBot:", err);
        broadcast({ type: 'error', message: `❌ Erreur critique inattendue: ${err.message}` });
        activeProcess.stop({ isSuccess: false }); // Nettoyage en cas d'erreur
    });
    res.status(200).json({ message: 'Processus de recording démarré.' });
});

app.post('/stop-recording', async (req, res) => {
    if (!activeProcess.isRunning) {
        return res.status(404).json({ error: 'Aucun processus à arrêter.' });
    }
    await activeProcess.stop({ isSuccess: false });
    res.status(200).json({ message: 'Demande d\'arrêt envoyée.' });
});
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
        NAME_INPUT: 'input[placeholder*="Votre nom"], input[placeholder*="Your name"], input[aria-label*="name"], input[aria-label*="nom"]',
        JOIN_BUTTON: 'button[jsname="Qx7uuf"],[data-call-to-action="join"],[data-call-to-action="Ask to join"],[data-call-to-action="Participer"],[data-call-to-action="Passer"]',
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

    // // Fonction pour vérifier si la page Meet s'est bien chargée
    // async function checkPageLoadSuccess(page) {
    //     const checks = [
    //         // Vérifier la présence d'éléments essentiels de Google Meet
    //         () => page.$('[data-meeting-title], [jsname="r4nke"], .google-material-icons'),
            
    //         // Vérifier que le DOM contient des éléments Meet spécifiques
    //         () => page.evaluate(() => {
    //             const indicators = [
    //                 document.querySelector('[role="main"]'),
    //                 document.querySelector('[data-call-to-action]'),
    //                 document.querySelector('input[placeholder*="nom"], input[placeholder*="name"]'),
    //                 document.title.toLowerCase().includes('meet'),
    //                 window.location.href.includes('meet.google.com')
    //             ];
    //             return indicators.some(indicator => indicator);
    //         }),
            
    //         // Vérifier les ressources réseau critiques
    //         () => page.evaluate(() => {
    //             return window.performance && 
    //                 window.performance.navigation.type !== 2 &&
    //                 document.readyState === 'complete';
    //         }),
            
    //         // Vérifier l'absence d'erreurs de chargement
    //         () => page.evaluate(() => {
    //             const errorTexts = ['error', 'erreur', 'impossible', 'failed', 'échec'];
    //             const bodyText = document.body?.textContent?.toLowerCase() || '';
    //             return !errorTexts.some(error => bodyText.includes(error));
    //         })
    //     ];
        
    //     try {
    //         await new Promise(resolve => setTimeout(resolve, 2000));
            
    //         const results = await Promise.all(checks.map(check => check().catch(() => false)));
    //         const successCount = results.filter(Boolean).length;
    //         console.log(`   - Vérifications de chargement: ${successCount}/${checks.length} réussies`);
            
    //         return successCount >= 2;
            
    //     } catch (error) {
    //         console.error('   - Erreur lors de la vérification du chargement:', error.message);
    //         return false;
    //     }
    // }

    // // Fonction pour rafraîchir la page avec stratégies multiples
    // async function refreshPageWithStrategy(page, strategy = 'reload') {
    //     console.log(`   - 🔄 Rafraîchissement avec stratégie: ${strategy}`);
        
    //     try {
    //         switch (strategy) {
    //             case 'reload':
    //                 await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    //                 break;
                    
    //             case 'goto':
    //                 await page.goto(meetLink, { waitUntil: 'networkidle2', timeout: 30000 });
    //                 break;
                    
    //             case 'hard_reload':
    //                 await page.evaluate(() => window.location.reload(true));
    //                 await page.waitForLoadState?.('networkidle', { timeout: 30000 }).catch(() => {
    //                     return new Promise(resolve => setTimeout(resolve, 5000));
    //                 });
    //                 break;
                    
    //             case 'new_navigation':
    //                 await page.goto('about:blank');
    //                 await randomDelay(1000, 2000);
    //                 await page.goto(meetLink, { waitUntil: 'networkidle2', timeout: 30000 });
    //                 break;
                    
    //             default:
    //                 await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
    //         }
            
    //         await randomDelay(2000, 4000);
    //         return true;
            
    //     } catch (error) {
    //         console.error(`   - ❌ Échec du rafraîchissement (${strategy}):`, error.message);
    //         return false;
    //     }
    // }

    // Fonction pour détecter et gérer les popups
    async function handlePopups(page) {
        const popupHandlers = [
            {
                name: 'Connexion Google',
                // Cherche un bouton qui contient le texte "OK" ou "Got it"
                selector: '::-p-xpath(//button[.//span[contains(., "OK")] or .//span[contains(., "Got it")]])'
            },
            {
                name: 'Notifications',
                selector: 'button[jsname="V67aGc"]'
            }
        ];

        for (const handler of popupHandlers) {
            try {
                const element = await page.waitForSelector(handler.selector, { timeout: 3000, visible: true });
                if (element) {
                    broadcast({ type: 'status', message: `🖱️ Popup "${handler.name}" détecté et fermé.` });
                    await element.click();
                    await randomDelay(1000, 1500);
                }
            } catch (e) {
                // Le popup n'a pas été trouvé, on continue. C'est normal.
            }
        }
    }

    async function handlePopupsDissmiss(page) {
        const popupHandlers = [
            {
                name: 'Caméra introuvable',
                // Cherche un bouton contenant "Ignorer" (fr) ou "Dismiss" (en)
                selector: '::-p-xpath(//button[contains(., "Ignorer") or contains(., "Dismiss")])'
            },
            {
                name: 'Notifications',
                selector: 'button[jsname="V67aGc"]'
            }
        ];

        for (const handler of popupHandlers) {
            try {
                const element = await page.waitForSelector(handler.selector, { timeout: 3000, visible: true });
                if (element) {
                    broadcast({ type: 'status', message: `🖱️ Popup "${handler.name}" détecté et fermé.` });
                    await element.click();
                    await randomDelay(1000, 1500);
                }
            } catch (e) {
                // Le popup n'a pas été trouvé, on continue. C'est normal.
            }
        }
    }


    function startRecordingWithFFmpeg(fileName) {
        let ffmpegArgs = [];
        const platform = os.platform();

        if (platform === 'linux') {
            ffmpegArgs = [
                '-f', 'pulse',
                '-i', 'virtual_sink.monitor',
                '-acodec', 'libmp3lame',
                '-q:a', '2',
                fileName
            ];
        } else if (platform === 'win32') {
            ffmpegArgs = ['-f', 'dshow', '-i', 'audio=Stereo Mix (Realtek(R) Audio)', '-acodec', 'libmp3lame', '-q:a', '2', fileName];
        } else if (platform === 'darwin') {
            ffmpegArgs = ['-f', 'avfoundation', '-i', ':1', '-acodec', 'libmp3lame', fileName];
        }
        
        activeProcess.ffmpeg = spawn('ffmpeg', ffmpegArgs);
        activeProcess.ffmpeg.stderr.on('data', (data) => console.error(`ffmpeg stderr: ${data.toString()}`));
        activeProcess.ffmpeg.on('close', (code) => {
            if(activeProcess.isRunning) {
                broadcast({ type: 'status', message: `✅ Enregistrement FFmpeg terminé (code ${code}).`});
            }
        });
    }
    
    function stopRecordingWithFFmpeg() {
        return new Promise((resolve) => {
            if (!ffmpegProcess || ffmpegProcess.killed) return resolve();
            broadcast({ type: 'status', message: '⏹️ Arrêt de l\'enregistrement FFmpeg...' });
            ffmpegProcess.kill('SIGINT');
            ffmpegProcess.on('close', resolve);
        });
    }

    //===============================================Methode==========================================

    // Configuration des constantes
    const MEET_LOAD_CONFIG = {
        MAX_REFRESH_ATTEMPTS: 4,
        BASE_TIMEOUT: 30000,
        NETWORK_IDLE_TIMEOUT: 10000,
        VERIFICATION_DELAY: 3000,
        RETRY_DELAY: { min: 2000, max: 5000 }
    };

    // Stratégies de rafraîchissement améliorées
    const refreshStrategies = [
        'soft_reload',      // Reload standard
        'hard_navigation',  // Navigation complète
        'cache_bypass',     // Bypass du cache
        'fresh_context'     // Nouvelle navigation avec nettoyage
    ];

    // Fonction avancée pour vérifier le chargement de Google Meet
    async function checkMeetPageLoadSuccess(page) {
        const verifications = [
            // 1. Vérifier les éléments UI critiques de Meet
            async () => {
                try {
                    const criticalElements = await page.evaluate(() => {
                        const selectors = [
                            '[data-meeting-title]',
                            '[jsname="r4nke"]',
                            '[role="main"]',
                            '.google-material-icons',
                            '[data-call-to-action]',
                            'input[placeholder*="nom"], input[placeholder*="name"], input[aria-label*="name"]',
                            '[data-promo-anchor-id]',
                            '.VfPpkd-LgbsSe' // Boutons Material Design
                        ];
                        
                        return selectors.some(selector => {
                            const element = document.querySelector(selector);
                            return element && element.offsetParent !== null; // Visible
                        });
                    });
                    
                    return criticalElements;
                } catch (error) {
                    console.error('Erreur vérification éléments UI:', error);
                    return false;
                }
            },

            // 2. Vérifier l'état de l'application Meet
            async () => {
                try {
                    return await page.evaluate(() => {
                        // Vérifier le titre de la page
                        const titleCheck = document.title.toLowerCase().includes('meet') || 
                                        document.title.toLowerCase().includes('google');
                        
                        // Vérifier l'URL
                        const urlCheck = window.location.href.includes('meet.google.com');
                        
                        // Vérifier la présence de scripts Meet
                        const scriptsCheck = Array.from(document.scripts).some(script => 
                            script.src.includes('meet') || script.src.includes('google')
                        );
                        
                        // Vérifier les variables globales Meet
                        const globalsCheck = typeof window.meetApiReady !== 'undefined' ||
                                        typeof window.gapi !== 'undefined' ||
                                        window.location.pathname.includes('/meet/');
                        
                        return titleCheck && urlCheck && (scriptsCheck || globalsCheck);
                    });
                } catch (error) {
                    console.error('Erreur vérification état Meet:', error);
                    return false;
                }
            },

            // 3. Vérifier les ressources réseau et l'état de chargement
            async () => {
                try {
                    return await page.evaluate(() => {
                        // État du document
                        const documentReady = document.readyState === 'complete';
                        
                        // Vérifier les performances réseau
                        const networkCheck = window.performance && 
                                        window.performance.navigation.type !== 2; // Pas de navigation arrière
                        
                        // Vérifier qu'il n'y a pas d'erreurs de chargement visibles
                        const noLoadingIndicators = !document.querySelector('.loading, .spinner, [aria-label*="loading"]');
                        
                        return documentReady && networkCheck && noLoadingIndicators;
                    });
                } catch (error) {
                    console.error('Erreur vérification réseau:', error);
                    return false;
                }
            },

            // 4. Vérifier l'absence d'erreurs spécifiques à Meet
            async () => {
                try {
                    return await page.evaluate(() => {
                        const errorPatterns = [
                            'something went wrong',
                            'unable to connect',
                            'meeting not found',
                            'invalid meeting',
                            'meeting has ended',
                            'erreur',
                            'impossible de se connecter',
                            'réunion introuvable',
                            'error',
                            'failed to join',
                            'network error'
                        ];
                        
                        const bodyText = (document.body?.textContent || '').toLowerCase();
                        const hasErrors = errorPatterns.some(pattern => bodyText.includes(pattern));
                        
                        // Vérifier les éléments d'erreur
                        const errorElements = document.querySelectorAll('[role="alert"], .error, .warning');
                        const hasErrorElements = Array.from(errorElements).some(el => 
                            el.textContent && errorPatterns.some(pattern => 
                                el.textContent.toLowerCase().includes(pattern)
                            )
                        );
                        
                        return !hasErrors && !hasErrorElements;
                    });
                } catch (error) {
                    console.error('Erreur vérification erreurs:', error);
                    return true; // Si on ne peut pas vérifier, on assume pas d'erreur
                }
            },

            // 5. Vérifier la réactivité de l'interface
            async () => {
                try {
                    // Attendre que les animations se terminent
                    await page.waitForFunction(() => {
                        const animations = document.getAnimations();
                        return animations.length === 0 || animations.every(anim => anim.playState === 'finished');
                    }, { timeout: 5000 }).catch(() => {});
                    
                    // Vérifier que la page répond aux interactions
                    return await page.evaluate(() => {
                        const interactiveElements = document.querySelectorAll('button, input, [role="button"]');
                        return interactiveElements.length > 0;
                    });
                } catch (error) {
                    console.error('Erreur vérification réactivité:', error);
                    return true; // Si on ne peut pas vérifier, on assume que c'est OK
                }
            }
        ];

        try {
            // Attendre un délai de stabilisation
            await new Promise(resolve => setTimeout(resolve, MEET_LOAD_CONFIG.VERIFICATION_DELAY));
            
            // Exécuter toutes les vérifications
            const results = await Promise.allSettled(
                verifications.map(check => check())
            );
            
            const successfulChecks = results.filter(result => 
                result.status === 'fulfilled' && result.value === true
            ).length;
            
            const totalChecks = results.length;
            const successRate = successfulChecks / totalChecks;
            
            console.log(`   - Vérifications de chargement Meet: ${successfulChecks}/${totalChecks} réussies (${Math.round(successRate * 100)}%)`);
            
            // Considérer comme succès si au moins 60% des vérifications passent
            return successRate >= 0.6;
            
        } catch (error) {
            console.error('   - Erreur lors de la vérification du chargement Meet:', error.message);
            return false;
        }
    }

    // Fonction de rafraîchissement optimisée pour Meet
    async function refreshMeetPageWithStrategy(page, meetLink, strategy = 'soft_reload') {
        console.log(`   - 🔄 Rafraîchissement Meet avec stratégie: ${strategy}`);
        
        try {
            switch (strategy) {
                case 'soft_reload':
                    await page.reload({ 
                        waitUntil: 'networkidle2', 
                        timeout: MEET_LOAD_CONFIG.BASE_TIMEOUT 
                    });
                    break;
                    
                case 'hard_navigation':
                    await page.goto(meetLink, { 
                        waitUntil: 'networkidle2', 
                        timeout: MEET_LOAD_CONFIG.BASE_TIMEOUT 
                    });
                    break;
                    
                case 'cache_bypass':
                    // Forcer le rechargement en bypassant le cache
                    await page.evaluate(() => {
                        window.location.reload(true);
                    });
                    // Attendre que la page se recharge
                    await page.waitForLoadState('networkidle', { 
                        timeout: MEET_LOAD_CONFIG.BASE_TIMEOUT 
                    }).catch(() => {
                        return new Promise(resolve => setTimeout(resolve, 8000));
                    });
                    break;
                    
                case 'fresh_context':
                    // Navigation vers une page blanche puis vers Meet
                    await page.goto('about:blank');
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Nettoyer le cache et les cookies pour ce domaine si possible
                    try {
                        await page.evaluate(() => {
                            if ('serviceWorker' in navigator) {
                                navigator.serviceWorker.getRegistrations()
                                    .then(registrations => registrations.forEach(reg => reg.unregister()));
                            }
                        });
                    } catch (e) {
                        // Ignorer si pas possible
                    }
                    
                    await page.goto(meetLink, { 
                        waitUntil: 'networkidle2', 
                        timeout: MEET_LOAD_CONFIG.BASE_TIMEOUT 
                    });
                    break;
                    
                default:
                    await page.reload({ 
                        waitUntil: 'networkidle2', 
                        timeout: MEET_LOAD_CONFIG.BASE_TIMEOUT 
                    });
            }
            
            // Délai supplémentaire pour laisser Meet se stabiliser
            await new Promise(resolve => setTimeout(resolve, 
                Math.random() * (MEET_LOAD_CONFIG.RETRY_DELAY.max - MEET_LOAD_CONFIG.RETRY_DELAY.min) + 
                MEET_LOAD_CONFIG.RETRY_DELAY.min
            ));
            
            return true;
            
        } catch (error) {
            console.error(`   - ❌ Échec du rafraîchissement Meet (${strategy}):`, error.message);
            return false;
        }
    }

















    //===============================================chrome==========================================
    try {
        // Détection Chrome
        let chromePath = '';
        const platform = os.platform();
        if (platform === 'darwin') {
            chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
        } else if (platform === 'win32') {
            const paths = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', `${os.homedir()}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`];
            chromePath = paths.find(p => fs.existsSync(p));
            // chromePath = 'C:/Program Files/Mozilla Firefox/firefox.exe';
        } else {
            chromePath = '/usr/bin/google-chrome';
        }

        broadcast({ type: 'status', message: '🚀 Lancement du navigateur...' });
        activeProcess.browser = await launch({
            executablePath: chromePath || undefined,
            // executablePath: './node_modules/chromium/lib/chromium/chrome-linux/chrome',
            // headless: false, // Mettez `true` pour une exécution sans interface graphique
            headless: "new",
            args: [
                '--lang=fr-FR,fr',
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
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream'
            ]
        });

        // // Détection Firefox
        // let firefoxPath = '';
        // const platform = os.platform();

        // if (platform === 'darwin') {
        //     // macOS
        //     firefoxPath = '/Applications/Firefox.app/Contents/MacOS/firefox';
        // } else if (platform === 'win32') {
        //     // Windows - plusieurs emplacements possibles
        //     const paths = [
        //         'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
        //         'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe',
        //         `${os.homedir()}\\AppData\\Local\\Mozilla Firefox\\firefox.exe`
        //     ];
        //     firefoxPath = paths.find(p => fs.existsSync(p));
        // } else {
        //     // Linux
        //     const paths = [
        //         '/usr/bin/firefox',
        //         '/usr/local/bin/firefox',
        //         '/opt/firefox/firefox',
        //         '/snap/bin/firefox'
        //     ];
        //     firefoxPath = paths.find(p => fs.existsSync(p)) || 'firefox';
        // }

        // broadcast({ type: 'status', message: '🦊 Lancement de Firefox...' });

        // // Configuration pour Firefox
        // activeProcess.browser = await launch({
        //     product: 'firefox', // Spécifie Firefox comme navigateur
        //     executablePath: firefoxPath || undefined,
        //     headless: false, // Interface graphique visible
        //     args: [
        //         '--no-sandbox',
        //         '--disable-setuid-sandbox',
        //         '--width=1920',
        //         '--height=1080',
        //         '--disable-web-security',
        //         '--disable-dev-shm-usage',
        //         '--no-first-run',
        //         '--disable-extensions',
        //         // Arguments spécifiques à Firefox
        //         '--new-instance',
        //         '--no-remote',
        //         '--safe-mode', // Mode sans extensions pour éviter les conflits
        //         '--disable-background-updates'
        //     ],
        //     // Options spécifiques à Firefox
        //     firefoxUserPrefs: {
        //         'dom.webdriver.enabled': false,
        //         'useAutomationExtension': false,
        //         'general.platform.override': 'Win32',
        //         'general.useragent.override': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0'
        //     }
        // });


        
        // Masquer les propriétés webdriver
        const context = activeProcess.browser.defaultBrowserContext();
        const origin = new URL(meetLink).origin;
        await context.overridePermissions(origin, ['microphone', 'camera', 'notifications']);
        console.log(`✅ Permissions accordées pour l'origine : ${origin}`);

        const page = await activeProcess.browser.newPage();
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
                    timeout: 30000
                });
                await new Promise(resolve => setTimeout(resolve, 2000));
                await handlePopups(page);
                await new Promise(resolve => setTimeout(resolve, 5000));
                await handlePopupsDissmiss(page);

                // Vérification du chargement initial
                broadcast({ type: 'info', message: `- Checking de la page meet !` });
                const initialLoadSuccess = await checkMeetPageLoadSuccess(page);
                
                if (!initialLoadSuccess) {
                    console.warn('   - ⚠️ Chargement Meet initial défaillant, tentatives de rafraîchissement...');
                    
                    let refreshSuccess = false;
                    
                    for (let refreshAttempt = 1; refreshAttempt <= MEET_LOAD_CONFIG.MAX_REFRESH_ATTEMPTS; refreshAttempt++) {
                        const strategy = refreshStrategies[(refreshAttempt - 1) % refreshStrategies.length];
                        
                        broadcast({ 
                            type: 'status', 
                            message: `   - 🔄 Rafraîchissement Meet ${refreshAttempt}/${MEET_LOAD_CONFIG.MAX_REFRESH_ATTEMPTS} (${strategy})`
                        });
                        
                        const refreshResult = await refreshMeetPageWithStrategy(page, meetLink, strategy);
                        
                        if (refreshResult) {
                            broadcast({ type: 'info', message: `- Nouveau checking de la page meet !` });
                            const loadCheckAfterRefresh = await checkMeetPageLoadSuccess(page);
                            if (loadCheckAfterRefresh) {
                                broadcast({ 
                                    type: 'status', 
                                    message: '   - ✅ Page Meet chargée avec succès après rafraîchissement !'
                                });
                                refreshSuccess = true;
                                break;
                            }
                        }
                        
                        // Attendre avant le prochain rafraîchissement
                        if (refreshAttempt < MEET_LOAD_CONFIG.MAX_REFRESH_ATTEMPTS) {
                            await new Promise(resolve => setTimeout(resolve, 
                                Math.random() * (MEET_LOAD_CONFIG.RETRY_DELAY.max - MEET_LOAD_CONFIG.RETRY_DELAY.min) + 
                                MEET_LOAD_CONFIG.RETRY_DELAY.min
                            ));
                        }
                    }
                    
                    if (!refreshSuccess) {
                        broadcast({ 
                            type: 'status', 
                            message: '   - ❌ Tous les rafraîchissements Meet ont échoué pour cette tentative'
                        });
                        return false;
                    }
                } else {
                    broadcast({ 
                        type: 'status', 
                        message: '   - ✅ Page Meet chargée correctement dès la première navigation'
                    });
                }

                // Continuer avec la logique de connexion normale
                await randomDelay(3000, 6000);
                await new Promise(resolve => setTimeout(resolve, 3000));
                await handlePopups(page);
                await new Promise(resolve => setTimeout(resolve, 3000));
                await handlePopupsDissmiss(page);

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

                await new Promise(resolve => setTimeout(resolve, 3000));
                await handlePopupsDissmiss(page);

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
                // const joinButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Participer")] or .//span[contains(text(), "Passer")]])', { timeout: 10000 });
                // await joinButton.click();
                
                const joinButtonSelector = '::-p-xpath(//button[.//span[contains(., "Participer")] or .//span[contains(., "Ask to join")] or .//span[contains(., "Join now")] or .//span[contains(., "Passer")]])';
                
                const joinButton = await page.waitForSelector(joinButtonSelector, { timeout: 15000 }); 

                // const joinButton = await page.waitForSelector(SELECTORS.JOIN_BUTTON, { timeout: 15000 });
                await joinButton.click();
                
                // Cliquer sur "Participer"
                // const joinButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Participer")] or .//span[contains(text(), "Passer")] or .//span[contains(text(), "Join"])', { timeout: 10000 });

                // // --- NOUVELLE LOGIQUE D'ATTENTE D'ADMISSION ---
                // broadcast({ type: 'status', message: '🚪 Demande de participation envoyée. En attente d\'admission...' });

                // // const admissionTimeout = 300000; // 5 minutes d'attente max
                // const admissionTimeout = 60000; // 1 minutes d'attente max
                // const checkInterval = 15000; // Vérifier toutes les 5 secondes
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
                
                await page.waitForSelector(SELECTORS.LEAVE_BUTTON, { timeout: 20000 });
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

        if(connected){
            // ENREGISTREMENT
            const recordingsFolder = 'recordings';
            if (!fs.existsSync(recordingsFolder)) fs.mkdirSync(recordingsFolder);

            activeProcess.filePath = `${recordingsFolder}/meeting-${Date.now()}.mp3`;
            startRecordingWithFFmpeg(activeProcess.filePath);
            broadcast({ 
                type: 'recording_started', 
                message: `🔴 L'enregistrement a commencé.`, 
                duration: RECORDING_DURATION_MS / 1000 
            });
            
            // Démarrer le timer côté serveur
            activeProcess.recordingTimer = setTimeout(() => {
                activeProcess.stop({ isSuccess: true });
            }, RECORDING_DURATION_MS);
        }
       
        
    } catch (error) {
        let errorMessage = error.message;
        if (error.name === 'TimeoutError') {
            errorMessage = "Le bot n'a pas été admis dans la réunion après 5 minutes ou un élément de la page (comme le bouton 'Participer') n'a pas pu être trouvé.";
        }
        broadcast({ type: 'error', message: `❌ Erreur critique: ${errorMessage}` });

        if (page) {
            const screenshotPath = `recordings/failure_screenshot_${Date.now()}.png`;
            try {
                await page.screenshot({ path: screenshotPath, fullPage: true });
                broadcast({ type: 'warning', message: `📸 Capture d'écran de l'erreur sauvegardée dans : ${screenshotPath}` });
            } catch (screenshotError) {
                broadcast({ type: 'warning', message: `⚠️ Impossible de prendre une capture d'écran: ${screenshotError.message}` });
            }
        }

        await activeProcess.stop({ isSuccess: false });
    }
}


// Démarrage du serveur
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Serveur démarré sur http://localhost:${PORT}`);
    console.log('Ouvrez public/index.html dans votre navigateur.');
});
