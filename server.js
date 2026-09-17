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
    // Piste d'amélioration : envoyer un email ou un message Telegram ici
    // pour être notifié en temps réel qu'il faut commander chez le fournisseur.
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
      // On garde le détail du panier (id produit + lien fournisseur) dans les métadonnées
      // pour retrouver facilement quoi commander chez le fournisseur après le paiement.
      metadata: {
        cart: JSON.stringify(
          items.map((i) => ({ id: i.productId, qty: i.quantity, supplierUrl: i.supplierUrl || '' }))
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
    cart,
    fulfilled: false, // passe à true une fois que tu as commandé chez le fournisseur
  });
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`Serveur Shop'N'Go démarré sur le port ${PORT}`));
