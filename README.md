# Bloom V2

School-first rebuild of the Bloom food-surplus recovery network.

## Run locally

```bash
npm install
npm run dev
```

The development scripts explicitly select the file-backed repository. The web app runs at `http://localhost:5175` and the API at `http://localhost:5002`.

Demo credentials:

- School: `SCH-DEMO` / `bloom-school`
- Admin: `ADMIN-BLOOM` / `bloom-admin`

The file repository is for local development only. For PostgreSQL, set `DATA_DRIVER=postgres` and provide `DATABASE_URL`.
