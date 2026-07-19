# Job Cost Analyst — Setup Guide

## 1. Supabase Setup

### Create a Supabase Project
1. Go to [supabase.com](https://supabase.com) and sign in
2. Click **New Project**, choose your organization, give it a name (e.g., "job-cost-app"), set a strong database password, select a region
3. Wait for the project to provision (~1 minute)

### Get Your API Keys
In your Supabase project dashboard, go to **Settings → API**:
- Copy **Project URL** → used for `NEXT_PUBLIC_SUPABASE_URL`
- Copy **anon / public key** → used for `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Copy **service_role / secret key** → used for `SUPABASE_SERVICE_ROLE_KEY`

### Create the Users Table
Go to **SQL Editor** in your Supabase dashboard and run:

```sql
CREATE TABLE users (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'standard' CHECK (role IN ('admin', 'standard')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_username ON users(username);
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
```

### Create Your First Admin User
```sql
-- Generate a hash first: node -e "const b=require('bcryptjs');b.hash('yourpassword',10).then(h=>console.log(h))"
INSERT INTO users (username, password_hash, role)
VALUES ('admin', '$2a$10$YourBcryptHashHere', 'admin');
```

---

## 2. Environment Variables

Create a `.env.local` file in the project root:

```env
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
JWT_SECRET=generate-a-random-32-char-string-here
ANTHROPIC_API_KEY=sk-ant-...
ACUMATICA_URL=https://your-instance.acumatica.com/
ACUMATICA_USERNAME=your_username
ACUMATICA_PASSWORD=your_password
ACUMATICA_TENANT=your_tenant
```

**Generate JWT_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 3. GitHub + Vercel Deployment

```bash
cd job-cost-app
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/yourusername/acumatica-job-cost-app.git
git push -u origin main
```

Then deploy via [vercel.com](https://vercel.com) → Add New Project → import this repo → add env vars → Deploy.

---

## 4. Tech Stack

| Tech | Purpose |
|------|---------|
| Next.js 14 (App Router) | Framework |
| TypeScript | Type safety |
| Tailwind CSS | Styling |
| Supabase | User database |
| jose | JWT auth |
| bcryptjs | Password hashing |
| @anthropic-ai/sdk | Claude AI chat |
| Vercel | Hosting |