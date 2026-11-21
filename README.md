# MentorLagbe
Next.js + Express tuition marketplace with Better Auth JWT, MongoDB, Stripe test checkout, role dashboards, tuition CRUD, applications, approval, search and pagination.

1. Open server and client in separate terminals. Run `npm install` in each.
2. Copy server/.env.example to server/.env and client/.env.example to client/.env.local. Set MongoDB URI, Better Auth secret (32+ random characters), Stripe test secret, and admin email. Use exact local URLs initially.
3. Server: `node seed.js`, then `npm run dev`. Client: `npm run dev`.
4. Sign up with role Student or Tutor (admin is assigned by configured email). Test approval, applications, payments and mobile view before deployment.
5. Deploy server to a Node host and client to Vercel. Update both URL variables to deployed origins. Never commit env files.

Application database has four collections; Better Auth uses a separate database for authentication internals. This is an untested implementation, not a verified submission. Remaining work: ImgBB integration, dedicated loading/error/404 UI, admin user management, full requirement checks, real meaningful commits (20 client / 12 server), deployment and end-to-end tests. Payment verification currently occurs on return to the site, not via webhook.
