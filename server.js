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

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
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
