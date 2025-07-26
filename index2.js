// Import des modules nécessaires
const { spawn, fork } = require('child_process');
const os = require('os');
// On utilise 'launch' de puppeteer-stream pour s'assurer que le navigateur est correctement configuré pour le streaming
const { launch, getStream, wss } = require("puppeteer-stream"); 
const fs = require("fs");
const axios = require('axios'); // NOUVEAU
const FormData = require('form-data'); // NOUVEAU

// --- NOUVELLE CONFIGURATION PUPPETEER-EXTRA ---
const puppeteer = require('puppeteer-extra');

// Charger les plugins
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');

// Utiliser les plugins
puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true })); // Bloque les pubs et les trackers
puppeteer.use(AnonymizeUAPlugin()); // Fournit un User-Agent réaliste



// --- Configuration ---
const AGENT_NAME = "Agent-IA"; // Nom utilisé si la connexion est anonyme
const MEETING_LINK = process.argv[2]; // Récupère le lien de la réunion depuis les arguments de la ligne de commande
// const MEETING_LINK = process.env.MEETING_LINK;
// Pour la connexion, utilisez des variables d'environnement pour la sécurité
const GOOGLE_EMAIL = process.env.GOOGLE_EMAIL; 
const GOOGLE_PASSWORD = process.env.GOOGLE_PASSWORD;

const RECORDING_DURATION_MS = 22000; // Durée de l 'enregistrement en millisecondes (ici 60s)
const MAX_RETRIES = 3; // Nombre maximum de tentatives de connexion
const RETRY_DELAY_MS = 5000; // Délai entre les tentatives (5 secondes)

// Vérification de la présence du lien de la réunion
if (!MEETING_LINK) {
  console.error('❌ Erreur : Veuillez fournir un lien de réunion Google Meet.');
  console.log('Usage: node join-meet.js <lien_de_la_reunion>');
  process.exit(1);
}

let ffmpegProcess; // Pour garder une référence au processus FFmpeg

function startRecordingWithFFmpeg(fileName) {
    console.log(`🔴 Démarrage de l'enregistrement avec FFmpeg... Fichier : ${fileName}`);

    // La commande FFmpeg dépend de votre système d'exploitation
    let ffmpegArgs = [];
    const platform = os.platform();

    if (platform === 'win32') {
        // Pour Windows, il faut trouver le nom de votre périphérique de sortie audio.
        // Exécutez cette commande dans votre terminal pour lister vos périphériques :
        // ffmpeg -list_devices true -f dshow -i dummy
        // Remplacez "Haut-parleurs (Realtek High Definition Audio)" par le vôtre.
        ffmpegArgs = [
            '-f', 'dshow',
            // '-i', 'audio=Haut-parleurs (Realtek High Definition Audio)', // <== À CHANGER
            '-i', 'audio=Stereo Mix (Realtek(R) Audio)',
            // '-i', 'audio=Réseau de microphones (Technologie Intel® Smart Sound pour microphones numériques)',
            '-acodec', 'libmp3lame', // Enregistre en MP3
            '-q:a', '2', // Bonne qualité
            // '-acodec', 'libopus',
            // MODIFIÉ : Spécifie le débit pour la qualité (96k est excellent pour la voix)
            // '-b:a', '96k', 
            fileName
            // fileName.replace('.webm', '.mp3') // Sauvegarde en .mp3
        ];
    } else if (platform === 'darwin') { // macOS
         // Sur Mac, il faut souvent un outil comme BlackHole pour créer un périphérique de sortie virtuel.
         // Une fois BlackHole installé, vous trouverez son index avec : ffmpeg -f avfoundation -list_devices true -i ""
        ffmpegArgs = [
            '-f', 'avfoundation',
            '-i', ':1', // <== CHANGER l'index pour celui de BlackHole
            '-acodec', 'libmp3lame',
            fileName
        ];
    } else { // Linux
        ffmpegArgs = [
            '-f', 'pulse',
            '-i', 'default', // Capture la sortie audio par défaut
            '-acodec', 'libmp3lame',
            // '-acodec', 'libopus',
            // '-b:a', '96k',
            // fileName.replace('.webm', '.mp3')
            fileName
        ];
    }

    ffmpegProcess = spawn('ffmpeg', ffmpegArgs);

    ffmpegProcess.stdout.on('data', (data) => console.log(`ffmpeg: ${data}`));
    ffmpegProcess.stderr.on('data', (data) => console.error(`ffmpeg stderr: ${data.toString()}`));
    // ffmpegProcess.on('close', (code) => console.log(`FFmpeg s'est terminé avec le code ${code}`));
}

function stopRecordingWithFFmpeg() {
    return new Promise((resolve) => {
        if (!ffmpegProcess) return resolve();
        
        ffmpegProcess.on('close', (code) => {
            console.log(`✅ Enregistrement FFmpeg terminé proprement avec le code ${code}.`);
            resolve();
        });
        console.log('Signal d\'arrêt envoyé à FFmpeg...');
        ffmpegProcess.kill('SIGINT');
    });
}



(async () => {
    // --- Détection du chemin de Google Chrome ---
    let chromePath = '';
    const platform = os.platform();
    if (platform === 'darwin') { // macOS
        chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else if (platform === 'win32') { // Windows
        // Essaye plusieurs chemins courants pour Chrome sur Windows
        const paths = [
            // 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            `${os.homedir()}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`
        ];
        chromePath = paths.find(p => fs.existsSync(p));
    } else if (platform === 'linux') { // Linux
        chromePath = '/usr/bin/google-chrome';
    }

    // Vérifie si le chemin trouvé est valide
    if (chromePath && !fs.existsSync(chromePath)) {
        console.warn(`⚠️ Chrome non trouvé à l'emplacement : ${chromePath}`);
        chromePath = null; // Réinitialise pour laisser Puppeteer choisir
    }
    
    console.log(`🚀 Lancement du navigateur... (${chromePath ? 'Google Chrome' : 'Chromium par défaut'})`);
    
    let browser; // Déclarer le navigateur ici pour qu'il soit accessible dans le catch final
    
    try {
        // Utilisation de 'launch' de puppeteer-stream
        browser = await launch({
            executablePath: chromePath, // Utilise le chemin détecté ou null
            // CORRECTION: Utilisation du nouveau mode headless qui supporte mieux les extensions et les media streams
            headless: false, 
            // headless: "new",
            args: [
            //   '--no-sandbox', // Souvent nécessaire sur les serveurs Linux ou dans les conteneurs Docker pour que Chrome puisse se lancer
            //   '--disable-setuid-sandbox',
            //   '--disable-gpu', //  Désactiver le GPU Peut améliorer la stabilité dans certains environnements
              '--window-size=1920,1080', // Définir une taille de fenêtre est plus fiable
            //   // Les arguments 'use-fake-ui' pour la capture de média en mode headless
            //   '--use-fake-ui-for-media-stream',
            //   '--use-fake-device-for-media-stream',
            //   '--autoplay-policy=no-user-gesture-required',


            //   '--start-fullscreen', // Le mode fullscreen n'est pas toujours nécessaire en headless
            //   '--disable-infobars', // Enlève les barres d'information de Chrome
            ],
        });

        // --- Gestion proactive des permissions ---
        const context = browser.defaultBrowserContext();
        // L'URL doit être valide pour overridePermissions
        const origin = new URL(MEETING_LINK).origin;
        await context.overridePermissions(origin, ['microphone', 'camera', 'notifications']);
        console.log(`✅ Permissions accordées pour l'origine : ${origin}`);

        const page = await browser.newPage();
        // Définir un User-Agent pour paraître moins comme un bot
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');


        // Temps d'attente global pour être plus robuste
        // Pour chaque action d'attente (comme waitForSelector), attends jusqu'à 90 secondes avant d'abandonner."
        page.setDefaultTimeout(90000);

        // --- ÉTAPE 1: AUTHENTIFICATION (Optionnelle) ---
        // if (GOOGLE_EMAIL && GOOGLE_PASSWORD) {
            console.log('🔒 Tentative d\'authentification avec un compte Google...');
            await page.goto('https://accounts.google.com/');
            await page.waitForSelector('input[type="email"]');
            await page.type('input[type="email"]', 'marytra22@gmail.com');
            await page.click('#identifierNext');
            
            await page.waitForSelector('input[type="password"]', { visible: true });
            await page.type('input[type="password"]', 'waraWa.1');
            await page.click('#passwordNext');

            // console.log('... Attente de la page de mot de passe ou d\'une vérification...');
            // await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }); // Timeout augmenté à 60s

            // try {
            //     await page.waitForSelector('input[type="password"]', { visible: true, timeout: 5000 }); // Attendre le champ du mot de passe
            //     await page.type('input[type="password"]', GOOGLE_PASSWORD);

            //     // Utiliser un sélecteur plus robuste pour le bouton "Suivant"
            //     const passwordNextButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Suivant")]])');
            //     await passwordNextButton.click();

            //     // Attendre la fin de la navigation après la connexion
            //     await page.waitForNavigation({ waitUntil: 'networkidle2' });
                
            // } catch(e) {
            //     console.error("Impossible de trouver le champ du mot de passe. Une page de vérification a probablement été présentée.");
            //     await page.screenshot({ path: 'erreur_verification_google.png' });
            //     throw new Error("Échec à l'étape de vérification de Google. Utilisez un Mot de Passe d'Application.");
            // }
            
            // Attendre la fin de la navigation après la connexion
            await page.waitForNavigation({ waitUntil: 'networkidle2' });

            // GERER LA DEMANDE D'AUTHENTIFICATION PAR WINDOWS
            try {
                const notNowButton = await page.waitForSelector('button[jsname="V67aGc"]', { timeout: 2000 });
                if (notNowButton) {
                    console.log('🖱️ Clic sur "Pas maintenant" (Clés d\'accès).');
                    await notNowButton.click();
                    await page.waitForNavigation({ waitUntil: 'networkidle2' });
                }
            } catch (error) {
                console.log('✅ L\'écran "Clés d\'accès" n\'est pas apparu, on continue.');
            }
            console.log('🔐 Authentification terminée.');
        // } else {    
        //     console.log('👤 Connexion en tant qu\'invité anonyme.');
        // }

        // --- ÉTAPE 2: BOUCLE DE CONNEXION À LA RÉUNION AVEC RÉESSAIS ---
        let connected = false;
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            console.log(`\n▶️ Tentative de connexion n°${attempt}/${MAX_RETRIES}...`);
            try {
                await page.goto(MEETING_LINK, { waitUntil: 'networkidle2', timeout: 10000  });
                console.log('   - 👋 Préparation de la page...');
                await new Promise(resolve => setTimeout(resolve, 6000)); // Attente pour que la page se stabilise

                // --- NOUVEAU : GESTION DE LA POP-UP "NOTIFICATIONS" ---
                try {
                    const notificationPopupXPath = "//button[.//span[contains(text(), 'Pas maintenant')]]";
                    const notNowButton = await page.waitForSelector(`::-p-xpath(${notificationPopupXPath})`, { timeout: 5000 });
                    console.log('   - 🖱️ Désactivé Pop-up de notifications si détectée.');
                    await notNowButton.click();
                } catch (e) {
                    console.log('   - ✅ La pop-up de notifications n\'est pas apparue, on continue.');
                }

                // Désactiver micro et caméra avant de rejoindre
                await page.evaluate(() => {
                    const buttons = document.querySelectorAll('div[role="button"]');
                    buttons.forEach(button => {
                        const label = button.getAttribute('aria-label');
                        if (label && (label.toLowerCase().includes('désactiver le micro') || label.toLowerCase().includes('turn off microphone'))) {
                            console.log('   - 🎤 Microphone est activé. Tentative de désactivation...');
                            button.click();
                            console.log('   - ✅ Microphone désactivé.');
                        }
                        if (label && (label.toLowerCase().includes('désactiver la caméra') || label.toLowerCase().includes('turn off camera'))) {
                            console.log('   - 📹 La caméra est activée. Tentative de désactivation...');
                            button.click();
                            console.log('   - ✅ Caméra désactivée.');
                        }
                    });
                });
                // console.log('🎤 & 📹 Tentative de désactivation du micro et de la caméra.');

                // Gérer le cas de l'utilisateur anonyme
                try {
                    const nameInput = await page.waitForSelector('input[placeholder="Votre nom"]', { timeout: 3000 });
                    console.log(`👤 Inscription du nom : ${AGENT_NAME}`);
                    await nameInput.type(AGENT_NAME);
                } catch (e) {
                    console.log("Champ de nom non trouvé, l'utilisateur est probablement connecté.");
                }

                // --- NOUVEAU : GESTION DU POP-UP "POURSUIVEZ L'APPEL ICI" ---
                try {
                    // On cherche un bouton qui contient le texte "OK"
                    const continueCallXPath = "//button[.//span[contains(text(), 'OK')]]";
                    const okButton = await page.waitForSelector(`::-p-xpath(${continueCallXPath})`, { timeout: 5000 });
                    console.log('   - 🖱️ Pop-up "Poursuivez l\'appel ici" détecté. Clic sur "OK".');
                    await okButton.click();
                    // On attend un peu que l'interface se mette à jour après le clic
                    await new Promise(resolve => setTimeout(resolve, 2000)); 
                } catch (e) {
                    console.log('   - 👍 Le pop-up "Poursuivez l\'appel ici" n\'est pas apparu.');
                }

                // Cliquer sur "Participer"
                const joinButton = await page.waitForSelector('::-p-xpath(//button[.//span[contains(text(), "Participer")] or .//span[contains(text(), "Passer")]])', { timeout: 3000 });
                await joinButton.click();

                // Vérifier que la connexion est réussie en cherchant le bouton pour quitter
                await page.waitForSelector('button[aria-label*="Quitter l\'appel"], button[aria-label*="Leave call"]', { timeout: 8000 });
                console.log('✅ Connexion à la réunion réussie !');
                connected = true;
                break; // Sortir de la boucle

            } catch (error) {
                console.error(`   - ❌ Échec de la tentative n°${attempt}: ${error.message.split('\n')[0]}`);
                await page.screenshot({ path: `erreur_tentative_${attempt}.png` });
                if (attempt < MAX_RETRIES) {
                    console.log(`   - Attente de ${RETRY_DELAY_MS / 1000} secondes avant la prochaine tentative...`);
                    await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                }
            }
        }

        if (!connected) {
            throw new Error(`Impossible de se connecter à la réunion après ${MAX_RETRIES} tentatives.`);
        }

        // --- ÉTAPE DE STABILISATION AVANT ENREGISTREMENT ---
        console.log('... Attente de stabilisation avant enregistrement (5s)...');
        await new Promise(resolve => setTimeout(resolve, 5000));
        console.log('✅ Page stabilisée, tentative de capture du flux audio.');

        // const fileName = `enregistrement-${Date.now()}.webm`; // Le nom sera changé en .mp3 par la fonction
        const recordingsFolder = 'recordings'; // Nom du dossier mappé dans docker-compose
        if (!fs.existsSync(recordingsFolder)) {
            fs.mkdirSync(recordingsFolder);
        }
        // const fileName = `${recordingsFolder}/enregistrement-${Date.now()}.webm`; // MODIFIÉ
        const filePath = `${recordingsFolder}/enregistrement-${Date.now()}.mp3`; // MODIFIÉ
        startRecordingWithFFmpeg(filePath);
        
        console.log(`🔊 Enregistrement en cours pour ${RECORDING_DURATION_MS / 1000}s...`);

        // Attendre la fin de la durée d'enregistrement
        await new Promise(resolve => setTimeout(resolve, RECORDING_DURATION_MS));

        stopRecordingWithFFmpeg();
        console.log(`Le fichier sera sauvegardé sous "${filePath}".`);
        
        // Laisser un peu de temps à FFmpeg pour finaliser le fichier
        // await new Promise(resolve => setTimeout(resolve, 2000)); 

        // Envoyez le fichier .mp3 à votre backend
        // sendAudioForTranscription(fileName);

        // NOUVEL APPEL : Lancement du worker en arrière-plan
        console.log('🚀 Lancement du worker en arrière-plan pour l\'envoi du fichier...');
        const worker = fork('./upload-worker.js', [filePath], {
            detached: true, // Détache le processus enfant du parent
            stdio: 'ignore' // Ignore les entrées/sorties pour permettre au parent de se fermer
        });
        worker.unref(); // Permet au script parent de se terminer indépendamment de l'enfant

        // Le script principal peut maintenant se terminer immédiatement
        console.log("👋 Le script principal a terminé sa tâche. Le worker continue en arrière-plan.");


        // Quitter l'appel proprement
        try {
            const leaveButton = await page.$('button[aria-label*="Quitter l\'appel"]');
            if (leaveButton) {
                await leaveButton.click();
                console.log("👋 Appel quitté.");
            }
        } catch (e) {
            console.warn("Impossible de quitter l'appel.");
        }

        await browser.close();
        if (wss) (await wss).close();
        console.log("Navigateur et serveur websocket fermés.");
        process.exit(0);

    } catch (error) {
        console.error('❌ Une erreur critique est survenue :', error.message);
        // AMÉLIORATION: Gestion d'erreur plus robuste pour éviter le "TargetCloseError"
        if (browser) {
            try {
                const pages = await browser.pages();
                if (pages.length > 0) {
                    await pages[0].screenshot({ path: 'erreur_finale.png' });
                    console.log('Une capture d\'écran "erreur_finale.png" a été enregistrée.');
                }
            } catch (screenshotError) {
                console.error("Impossible de prendre une capture d'écran:", screenshotError.message);
            }
            await browser.close();
            console.log("Navigateur fermé après erreur.");
        }
        if (wss) {
            try {
                (await wss).close();
                console.log("Serveur websocket fermé après erreur.");
            } catch (wssError) {
                console.error("Impossible de fermer le serveur websocket:", wssError.message);
            }
        }
        process.exit(1);
    }
})();
