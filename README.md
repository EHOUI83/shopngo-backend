# Shop'N'Go — backend de paiement

Ce petit serveur fait deux choses, et rien de plus :
1. Il crée une session de paiement Stripe quand un client valide son panier.
2. Il enregistre la commande dans `orders.json` dès que Stripe confirme que le client a payé.

Aucune appli tierce (pas de Shopify, pas de DSers). Toi seul décides ensuite d'aller commander
chez le fournisseur avec le lien stocké dans chaque commande.

## 1. Installer

```bash
npm install
```

## 2. Configurer tes clés

```bash
cp .env.example .env
```

Puis remplis `.env` avec :
- `STRIPE_SECRET_KEY` : Développeurs → Clés API sur dashboard.stripe.com
- `STRIPE_WEBHOOK_SECRET` : voir étape 4 ci-dessous
- `SITE_URL` : le lien de ton site publié

## 3. Lancer en local pour tester

```bash
npm start
```

Le serveur tourne sur `http://localhost:4242`.

## 4. Configurer le webhook Stripe

Le webhook est ce qui te permet de savoir qu'un client a vraiment payé (et pas juste cliqué "payer" sans aller au bout).

- En local, installe le CLI Stripe puis lance :
  ```bash
  stripe listen --forward-to localhost:4242/webhook
  ```
  Il t'affiche un `whsec_...` à mettre dans `.env`.

- En production, dans le Dashboard Stripe : Développeurs → Webhooks → Ajouter un endpoint
  → mets l'URL `https://ton-serveur-deploye.com/webhook` → écoute l'événement `checkout.session.completed`
  → copie le "Signing secret" affiché dans `STRIPE_WEBHOOK_SECRET`.

## 5. Déployer le serveur

Ce code doit tourner en continu quelque part (pas juste sur ton ordinateur). Options simples et peu chères :
- **Render.com** (a un plan gratuit, le plus simple pour démarrer)
- **Railway.app**
- **Fly.io**

Sur ces trois, le principe est le même : tu connectes ton dépôt de code (GitHub) ou tu uploades ce dossier,
tu renseignes les mêmes variables d'environnement que dans `.env`, et ça déploie automatiquement.

## 6. Brancher le site dessus

Une fois le serveur déployé, tu obtiens une URL du style `https://shopngo-backend.onrender.com`.
Donne-la moi et je mets à jour le bouton "Valider la commande" du site pour qu'il appelle vraiment
`POST /create-checkout-session` au lieu de simuler la commande.

## Voir les commandes payées

```
GET https://ton-serveur/orders
```

Retourne la liste des commandes avec, pour chacune, le panier et le lien fournisseur à utiliser
pour commander manuellement. Marque `fulfilled: true` à la main une fois la commande passée
chez le fournisseur, pour t'y retrouver.
