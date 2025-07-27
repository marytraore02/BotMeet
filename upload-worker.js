// const fs = require('fs');
// const axios = require('axios');
// const FormData = require('form-data');

// // Récupère le chemin du fichier depuis les arguments passés par le script principal
// const filePath = process.argv[2];

// // L'URL du backend peut être passée en argument ou lue depuis .env
// const backendUrl = process.env.BACKEND_URL || 'http://127.0.0.1:8000/process_audio/';

// if (!filePath) {
//     console.error('Worker Error: No file path provided.');
//     process.exit(1);
// }

// async function sendAudio() {
//     if (!fs.existsSync(filePath)) {
//         console.error(`Worker Error: File not found at ${filePath}`);
//         return;
//     }

//     console.log(`[Worker] 🚀 Starting upload for: ${filePath}`);
//     const form = new FormData();
//     form.append('audio_file', fs.createReadStream(filePath));

//     try {
//         await axios.post(backendUrl, form, { headers: form.getHeaders() });
//         console.log(`[Worker] ✅ Successfully uploaded ${filePath}`);
//     } catch (error) {
//         console.error(`[Worker] ❌ Upload failed for ${filePath}:`, error.message);
//     } finally {
//         // Optionnel : supprimer le fichier après l'envoi
//         // fs.unlinkSync(filePath); 
//         // console.log(`[Worker] Cleaned up ${filePath}`);
//     }
// }

// // Lance le processus d'envoi
// sendAudio();







// Ce fichier est exécuté en tant que processus séparé.
// Il est conçu pour gérer l'upload du fichier audio sans bloquer le processus principal.

const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const filePath = process.argv[2];

if (!filePath) {
    console.error('Worker: Aucun chemin de fichier fourni.');
    process.exit(1);
}

// Fonction pour tenter l'upload avec plusieurs essais
async function uploadWithRetries(filePath, retries = 3, delay = 5000) {
    for (let i = 1; i <= retries; i++) {
        try {
            console.log(`Worker: Tentative d'upload n°${i} pour ${filePath}`);
            
            if (!fs.existsSync(filePath)) {
                 console.error(`Worker: Le fichier ${filePath} n'existe pas.`);
                 return;
            }

            const form = new FormData();
            form.append('audio_file', fs.createReadStream(filePath));
            
            // REMPLACEZ CETTE URL PAR L'ENDPOINT DE VOTRE API D'UPLOAD
            const uploadUrl = 'http://host.docker.internal:8000/process_audio/'; 

            const response = await axios.post(uploadUrl, form, {
                headers: {
                    ...form.getHeaders(),
                    // Ajoutez ici d'autres headers si nécessaire (ex: Authorization)
                },
            });

            console.log('Worker: Upload réussi !', response.data);
            
            // Optionnel: supprimer le fichier local après l'upload
            // fs.unlinkSync(filePath);
            // console.log(`Worker: Fichier local ${filePath} supprimé.`);

            return; // Sortir de la boucle si l'upload réussit

        } catch (error) {
            console.error(`Worker: Échec de la tentative d'upload n°${i}:`, error.message);
            if (i === retries) {
                console.error(`Worker: Toutes les tentatives d'upload pour ${filePath} ont échoué.`);
            } else {
                console.log(`Worker: Prochaine tentative dans ${delay / 1000} secondes...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
}

// Lancer le processus d'upload
uploadWithRetries(filePath).then(() => {
    console.log('Worker: Tâche d\'upload terminée.');
    process.exit(0);
});
