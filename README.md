# RjTask Backend

This is the backend service for the RjTask application, comprising a Middle Layer and a Backend DB Service.

## Environment Variables

Create a `.env` file in the root directory and add the following fields:

```env
PORT=5000                   # Middle Layer Port
PORT1=5001                  # Backend DB Service Port
NODE_ENV=development
HASH_SECRET=your_hash_secret
ACCESS_SECRET=your_access_token_secret
REFERSH_TOKEN=your_refresh_token_secret  # Note: Variable name is intentionally 'REFERSH_TOKEN'
DATABASE_URL=postgresql://user:password@localhost:5432/dbname?schema=public
BACKEND_URL=http://localhost:5001
```

## Setup & Database

This project uses Prisma as an ORM. Ensure you have your PostgreSQL database running and the `DATABASE_URL` is correctly set.

### Prisma Commands

1.  **Generate Prisma Client**: Run this after every schema change.
    ```bash
    npx prisma generate
    ```

2.  **Sync Database Schema**: Push the current `schema.prisma` to the database.
    ```bash
    npx prisma db push
    ```

3.  **Prisma Studio**: View and edit your database data in a web interface.
    ```bash
    npx prisma studio
    ```

4.  **Create Migration** (Optional): If you prefer using migrations instead of `db push`.
    ```bash
    npx prisma migrate dev --name init
    ```

## Running the Application

### Development Mode

To run both services (Middle Layer and Backend) concurrently:

```bash
npm run dev
```

### Production Mode

1.  **Build**:
    ```bash
    npm run build
    ```

2.  **Start**:
    ```bash
    npm start
    ```

## Naming Conventions

The project strictly follows **camelCase** for variables, object properties, and database fields, and **PascalCase** for models and types.

Linting and formatting are enforced via ESLint and Prettier. To check compliance:
```bash
npx eslint src
```
To fix formatting and naming issues automatically:
```bash
npx eslint src --fix
```
