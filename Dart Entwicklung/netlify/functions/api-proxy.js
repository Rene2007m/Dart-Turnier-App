const admin = require('firebase-admin');

// Firebase Admin initialisieren
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);

  if (serviceAccount.private_key) {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const action = event.queryStringParameters.action;
    const path = event.queryStringParameters.path;
    const conditions = event.queryStringParameters.conditions;
    
    let body = {};
    if (event.body) {
        try { body = JSON.parse(event.body); } catch(e) {}
    }

    // EINZELNES DOKUMENT LADEN
    if (action === 'getDoc') {
      const doc = await db.doc(path).get();
      return { statusCode: 200, headers, body: JSON.stringify({ exists: doc.exists, id: doc.id, data: doc.data() || {} }) };
    }

    // MEHRERE DOKUMENTE LADEN (MIT FILTER-OPTION)
    if (action === 'getDocs') {
      let ref = db.collection(path);
      if (conditions) {
        const conds = JSON.parse(conditions);
        conds.forEach(c => {
          ref = ref.where(c.field, c.op, c.value);
        });
      }
      const snap = await ref.get();
      const docs = snap.docs.map(d => ({ id: d.id, data: d.data() }));
      return { statusCode: 200, headers, body: JSON.stringify({ empty: snap.empty, docs }) };
    }

    // DOKUMENT ERSTELLEN ODER ÜBERSCHREIBEN
    if (action === 'setDoc') {
      await db.doc(path).set(body.data, body.options || {});
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // DOKUMENT AKTUALISIEREN
    if (action === 'updateDoc') {
      await db.doc(path).update(body.data);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    // DOKUMENT LÖSCHEN
    if (action === 'deleteDoc') {
      await db.doc(path).delete();
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Ungültige Aktion' }) };

  } catch (error) {
    console.error('Serverfehler:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};