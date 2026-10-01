const admin = require('firebase-admin');

// Firebase Admin SDK Initialisierung über FIREBASE_ADMIN_KEY
let db = null;

try {
    if (!admin.apps.length) {
        const serviceAccountStr = process.env.FIREBASE_ADMIN_KEY;
        if (serviceAccountStr) {
            const serviceAccount = JSON.parse(serviceAccountStr);
            
            // Korrektur für Zeilenumbrüche im Private Key
            if (serviceAccount.private_key) {
                serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
            }

            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        } else {
            console.warn("FIREBASE_ADMIN_KEY Umgebungsvariable fehlt.");
        }
    }
    
    if (admin.apps.length > 0) {
        db = admin.firestore();
    }
} catch (e) {
    console.error("Fehler beim Initialisieren von Firebase Admin:", e);
}

exports.handler = async (event, context) => {
    // CORS Header für Anfragen (Ersetze '*' bei Bedarf durch deine genaue Netlify-Domain)
    const headers = {
        'Access-Control-Allow-Origin': 'https://aucotec.netlify.app/',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Preflight-Anfrage (OPTIONS) direkt bestätigen
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'CORS Preflight OK' }) };
    }

    if (!db) {
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Datenbank-Verbindung nicht initialisiert. Überprüfe die Netlify Umgebungsvariablen (FIREBASE_ADMIN_KEY).' })
        };
    }

    try {
        const action = event.queryStringParameters ? event.queryStringParameters.action : null;
        const path = event.queryStringParameters ? event.queryStringParameters.path : null;

        if (!action || (!path && action !== 'login')) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: 'Fehlende Parameter: action und path sind erforderlich.' })
            };
        }

        const isWriteAction = ['setDoc', 'updateDoc', 'deleteDoc'].includes(action);
        const isSensitiveRead = (path && path.startsWith('users') && (action === 'getDocs' || action === 'getDoc'));

        const publicWritePaths = ['registrations', 'responses', 'planned_games'];
        const isPublicWrite = ['setDoc', 'updateDoc', 'deleteDoc'].includes(action) && publicWritePaths.some(publicPath => path && path.startsWith(publicPath));
        
        let requiresAuth = isSensitiveRead;
        if (isWriteAction && !isPublicWrite) {
            requiresAuth = true;
        }

        // ============================================================
        // SICHERHEITSPRÜFUNG (ADMIN AUTHENTIFIZIERUNG)
        // ============================================================
        if (requiresAuth) {
            const authHeader = event.headers.authorization || event.headers.Authorization;

            if (!authHeader) {
                return { statusCode: 401, headers, body: JSON.stringify({ error: 'Nicht autorisiert: Fehlende Zugangsdaten.' }) };
            }

            const [username, hash] = authHeader.split(':');

            if (!username || !hash) {
                return { statusCode: 401, headers, body: JSON.stringify({ error: 'Ungültiges Autorisierungsformat.' }) };
            }

            // Prüfe Nutzer in der Firebase-Datenbank
            const userDoc = await db.collection('users').doc(username).get();

            if (!userDoc.exists) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zugriff verweigert: Benutzer nicht gefunden.' }) };
            }

            const userData = userDoc.data();

            if (userData.password !== hash || userData.isAdmin !== true) {
                return { statusCode: 403, headers, body: JSON.stringify({ error: 'Zugriff verweigert: Keine Admin-Berechtigung oder falsches Passwort.' }) };
            }
        }

        // ============================================================
        // DATENBANK-AKTIONEN AUSFÜHREN
        // ============================================================
        
        switch (action) {
            case 'login': {
                const body = JSON.parse(event.body || '{}');
                const { username, hash } = body;
                
                if (!username || !hash) {
                    return { statusCode: 401, headers, body: JSON.stringify({ success: false }) };
                }

                const userDoc = await db.collection('users').doc(username).get();
                if (!userDoc.exists) {
                    return { statusCode: 403, headers, body: JSON.stringify({ success: false }) };
                }

                const userData = userDoc.data();
                if (userData.password !== hash) {
                    return { statusCode: 403, headers, body: JSON.stringify({ success: false }) };
                }

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        success: true,
                        isAdmin: userData.isAdmin === true
                    })
                };
            }

            case 'getDoc': {
                const snap = await db.doc(path).get();
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        exists: snap.exists,
                        id: snap.id,
                        data: snap.exists ? snap.data() : null
                    })
                };
            }

            case 'getDocs': {
                let queryRef = db.collection(path);
                const conditionsParam = event.queryStringParameters.conditions;

                if (conditionsParam) {
                    try {
                        const conditions = JSON.parse(conditionsParam);
                        conditions.forEach(c => {
                            if (c.field && c.op && c.value !== undefined) {
                                queryRef = queryRef.where(c.field, c.op, c.value);
                            }
                        });
                    } catch (e) {
                        console.error('Fehler beim Parsen der Conditions:', e);
                    }
                }

                const snap = await queryRef.get();
                const docs = snap.docs.map(d => ({
                    id: d.id,
                    data: d.data()
                }));

                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({
                        empty: snap.empty,
                        docs: docs
                    })
                };
            }

            case 'setDoc': {
                const body = JSON.parse(event.body || '{}');
                await db.doc(path).set(body.data || {}, body.options || {});
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }

            case 'updateDoc': {
                const body = JSON.parse(event.body || '{}');
                await db.doc(path).update(body.data || {});
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }

            case 'deleteDoc': {
                await db.doc(path).delete();
                return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            }

            default:
                return {
                    statusCode: 400,
                    headers,
                    body: JSON.stringify({ error: `Unbekannte Aktion: ${action}` })
                };
        }

    } catch (error) {
        console.error('API Proxy Fehler:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Interner Serverfehler', details: error.message })
        };
    }
};