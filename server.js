// Shop'N'Go — backend minimal pour encaisser de vrais paiements avec Stripe.
// Ce serveur ne parle à aucune appli tierce (pas de Shopify, pas de DSers) :
// juste Stripe pour le paiement, et un fichier local pour noter les commandes payées.

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const Stripe = require('stripe');

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();

const ORDERS_FILE = path.join(__dirname, 'orders.json');
const SITE_URL = process.env.SITE_URL || 'http://localhost:5173';
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
// Bot séparé, dédié uniquement à la réception des produits à ajouter —
// pour ne pas mélanger ça avec les notifications de commande.
const TELEGRAM_PRODUCT_TOKEN = process.env.TELEGRAM_PRODUCT_BOT_TOKEN;
const TELEGRAM_PRODUCT_CHAT_ID = process.env.TELEGRAM_PRODUCT_CHAT_ID;
// L'adresse publique de CE serveur, pour construire les liens d'images uploadées.
// Sur Render, elle est fournie automatiquement dans RENDER_EXTERNAL_URL.
const SERVER_URL = process.env.RENDER_EXTERNAL_URL || process.env.SERVER_URL || 'http://localhost:4242';

// Le webhook Stripe a besoin du corps brut (raw) de la requête pour vérifier
// la signature — donc on le déclare AVANT express.json() qui parse tout en JSON.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Signature webhook invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    saveOrder(session);
    console.log('✅ Nouvelle commande payée:', session.id, session.amount_total / 100, session.currency);
    notifyTelegram(session).catch(err => console.error('Erreur notification Telegram:', err.message));
  }

  res.json({ received: true });
});

app.use(cors());
app.use(express.json());
// Sert les photos uploadées via le bot Telegram, accessibles publiquement à /uploads/nom.jpg
app.use('/uploads', express.static(UPLOADS_DIR));

// ---------- Bot Telegram (produits) : reçoit tes produits, renvoie le code prêt à coller ----------
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // on répond tout de suite à Telegram, le traitement continue derrière
  try {
    const msg = req.body.message;
    if (!msg) return;

    // Sécurité : on ignore tout message qui ne vient pas de ton propre chat sur CE bot.
    if (String(msg.chat.id) !== String(TELEGRAM_PRODUCT_CHAT_ID)) return;

    const caption = msg.caption || msg.text || '';
    const fields = parseProductCaption(caption);

    if (!fields.nom) {
      await sendTelegramMessage(TELEGRAM_PRODUCT_TOKEN, TELEGRAM_PRODUCT_CHAT_ID,
        "Je n'ai pas trouvé le nom du produit. Envoie une légende avec ce format :\n\n" +
        "Nom: ...\nDescription: ... (optionnel)\nPrix: ...\nPrix avant: ... (optionnel)\nCategorie: electro|mode|maison|beaute|sport|jouets|auto|bricolage|animalerie|informatique|bijoux|cuisine|bebe|gadget\nLien: ...\nCouleurs: A, B, C (optionnel)\nTailles: S, M, L (optionnel)\nFrais de livraison: ... (optionnel)\nFrais import: ... (optionnel)"
      );
      return;
    }

    let imageUrl = null;
    if (msg.photo && msg.photo.length){
      const largest = msg.photo[msg.photo.length - 1];
      imageUrl = await downloadTelegramPhoto(TELEGRAM_PRODUCT_TOKEN, largest.file_id);
    }

    const code = buildProductCode(fields, imageUrl);
    await sendTelegramMessage(TELEGRAM_PRODUCT_TOKEN, TELEGRAM_PRODUCT_CHAT_ID, `Produit prêt ✅ Colle ceci dans REAL_PRODUCTS :\n\n\`\`\`\n${code}\n\`\`\``);
  } catch (err) {
    console.error('Erreur telegram-webhook:', err);
    try { await sendTelegramMessage(TELEGRAM_PRODUCT_TOKEN, TELEGRAM_PRODUCT_CHAT_ID, 'Erreur pendant le traitement : ' + err.message); } catch {}
  }
});

// Lit une légende du style "Nom: ...\nPrix: ...\n..." envoyée avec la photo.
function parseProductCaption(caption){
  const lines = caption.split('\n');
  const get = (label) => {
    const line = lines.find(l => l.toLowerCase().startsWith(label.toLowerCase() + ':'));
    return line ? line.split(':').slice(1).join(':').trim() : '';
  };
  const splitList = (v) => v ? v.split(',').map(s=>s.trim()).filter(Boolean) : [];
  return {
    nom: get('Nom'),
    description: get('Description'),
    prix: parseFloat(get('Prix').replace(',', '.')) || 0,
    prixAvant: parseFloat(get('Prix avant').replace(',', '.')) || 0,
    categorie: get('Categorie') || get('Catégorie') || 'gadget',
    lien: get('Lien'),
    couleurs: splitList(get('Couleurs')),
    tailles: splitList(get('Tailles')),
    fraisLivraison: parseFloat(get('Frais de livraison').replace(',', '.')) || 0,
    fraisImport: parseFloat((get('Frais import') || get('Frais d\'import') || get('Frais de douane')).replace(',', '.')) || 0,
  };
}

// Télécharge une photo envoyée sur Telegram et la sauvegarde dans /uploads, retourne son URL publique.
async function downloadTelegramPhoto(token, fileId){
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  const filePath = fileInfo.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const filename = `${Date.now()}.jpg`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return `${SERVER_URL}/uploads/${filename}`;
}

// Génère le texte JS à coller directement dans le tableau REAL_PRODUCTS du site.
function buildProductCode(fields, imageUrl){
  const id = Date.now();
  const hasOldPrice = fields.prixAvant > fields.prix;
  const discountPct = hasOldPrice ? Math.round((1 - fields.prix / fields.prixAvant) * 100) : 0;
  const lines = [
    '{',
    `  id: ${id},`,
    `  cat: '${fields.categorie}',`,
    `  name: ${JSON.stringify(fields.nom)},`,
    `  price: ${fields.prix},`,
    `  oldPrice: ${hasOldPrice ? fields.prixAvant : 'null'},`,
    `  discountPct: ${discountPct},`,
    `  rating: 4.5,`,
    `  ratingCount: 12,`,
    `  soldCount: 30,`,
  ];
  if (fields.description) lines.push(`  description: ${JSON.stringify(fields.description)},`);
  if (imageUrl) lines.push(`  image: '${imageUrl}',`);
  if (fields.lien) lines.push(`  supplierUrl: '${fields.lien}',`);
  if (fields.couleurs.length) lines.push(`  colors: ${JSON.stringify(fields.couleurs)},`);
  if (fields.tailles.length) lines.push(`  sizes: ${JSON.stringify(fields.tailles)},`);
  if (fields.fraisLivraison) lines.push(`  shippingFee: ${fields.fraisLivraison},`);
  if (fields.fraisImport) lines.push(`  importFee: ${fields.fraisImport},`);
  lines.push('},');
  return lines.join('\n');
}

// Envoie un message texte via un bot Telegram donné (token + chat_id passés en paramètres,
// pour pouvoir utiliser soit le bot "commandes", soit le bot "produits").
async function sendTelegramMessage(token, chatId, text){
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
  });
}


// Crée une session de paiement Stripe à partir du panier envoyé par le site.
app.post('/create-checkout-session', async (req, res) => {
  try {
    const { items, customerEmail } = req.body;
    // items attendu: [{ name, unitAmount (en centimes), quantity, productId, supplierUrl }]

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Panier vide.' });
    }

    const line_items = items.map((item) => ({
      price_data: {
        currency: 'eur',
        product_data: { name: item.name },
        unit_amount: Math.round(item.unitAmount), // en centimes, ex: 1399 pour 13,99€
      },
      quantity: item.quantity,
    }));

    // Frais de livraison et de douane/import : définis produit par produit
    // (via shippingFee/importFee sur chaque article). Si un article n'en a pas,
    // on retombe sur la règle générale du site (gratuit dès 50€, sinon 4,99€),
    // répartie sur les articles concernés.
    const FREE_SHIPPING_THRESHOLD = 5000; // 50,00€ en centimes
    const DEFAULT_SHIPPING_FEE = 499; // 4,99€ en centimes
    const cartTotal = items.reduce((sum, i) => sum + Math.round(i.unitAmount) * i.quantity, 0);

    let shippingTotal = 0;
    let importTotal = 0;
    let anyDefaultShipping = false;
    items.forEach((item) => {
      const qty = item.quantity || 1;
      if (item.shippingFee) {
        shippingTotal += Math.round(item.shippingFee * 100) * qty;
      } else {
        anyDefaultShipping = true; // cet article suit la règle générale du site
      }
      if (item.importFee) {
        importTotal += Math.round(item.importFee * 100) * qty;
      }
    });
    if (anyDefaultShipping && cartTotal < FREE_SHIPPING_THRESHOLD) {
      shippingTotal += DEFAULT_SHIPPING_FEE;
    }

    const extraLineItems = [];
    if (shippingTotal > 0) {
      extraLineItems.push({
        price_data: { currency: 'eur', product_data: { name: 'Frais de livraison' }, unit_amount: shippingTotal },
        quantity: 1,
      });
    }
    if (importTotal > 0) {
      extraLineItems.push({
        price_data: { currency: 'eur', product_data: { name: 'Frais de douane / import' }, unit_amount: importTotal },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [...line_items, ...extraLineItems],
      customer_email: customerEmail || undefined,
      // Sans ça, impossible de savoir où livrer le client une fois payé.
      shipping_address_collection: {
        allowed_countries: ['FR', 'BE', 'CH', 'LU', 'MC', 'DE', 'ES', 'IT', 'GB', 'US', 'CA']
      },
      // On garde le détail du panier (id produit + lien fournisseur) dans les métadonnées
      // pour retrouver facilement quoi commander chez le fournisseur après le paiement.
      metadata: {
        cart: JSON.stringify(
          items.map((i) => ({ id: i.productId, name: i.name, qty: i.quantity, supplierUrl: i.supplierUrl || '' }))
        ),
      },
      success_url: `${SITE_URL}?checkout=success`,
      cancel_url: `${SITE_URL}?checkout=cancel`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Liste simple des commandes payées (utile pour vérifier ce qu'il faut commander).
app.get('/orders', (req, res) => {
  res.json(readOrders());
});

function readOrders() {
  if (!fs.existsSync(ORDERS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveOrder(session) {
  const orders = readOrders();
  let cart = [];
  try {
    cart = JSON.parse(session.metadata.cart || '[]');
  } catch {}
  orders.push({
    id: session.id,
    date: new Date().toISOString(),
    amountTotal: session.amount_total / 100,
    currency: session.currency,
    customerEmail: session.customer_details ? session.customer_details.email : null,
    customerName: session.customer_details ? session.customer_details.name : null,
    shippingAddress: session.shipping_details ? session.shipping_details.address : null,
    cart,
    fulfilled: false, // passe à true une fois que tu as commandé chez le fournisseur
  });
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

// Envoie un message Telegram dès qu'une commande est payée, pour être prévenu en temps réel.
async function notifyTelegram(session) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // notification non configurée, on ignore silencieusement

  let cart = [];
  try { cart = JSON.parse(session.metadata.cart || '[]'); } catch {}

  const addr = session.shipping_details ? session.shipping_details.address : null;
  const addrText = addr
    ? `${addr.line1 || ''}${addr.line2 ? ', ' + addr.line2 : ''}, ${addr.postal_code || ''} ${addr.city || ''}, ${addr.country || ''}`
    : 'Adresse non fournie';

  const itemsText = cart.map(i => `• ${i.name} x${i.qty}${i.supplierUrl ? '\n  🔗 ' + i.supplierUrl : ''}`).join('\n');

  const text =
    `🛒 Nouvelle commande Shop'N'Go\n\n` +
    `💰 Montant : ${(session.amount_total / 100).toFixed(2)} ${session.currency.toUpperCase()}\n` +
    `👤 Client : ${session.customer_details ? session.customer_details.name : 'N/A'}\n` +
    `✉️ Email : ${session.customer_details ? session.customer_details.email : 'N/A'}\n` +
    `📦 Adresse : ${addrText}\n\n` +
    `Articles :\n${itemsText}`;

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text })
  });
}

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur Shop'N'Go démarré sur le port ${PORT}`));
