# API Documentation - Backend Services

This document provides a list of available API endpoints with `curl` examples.

## Base URL
`http://localhost:5000/api` (default development port)

---

## Authentication Endpoints

### 1. Register User
Creates a new user account.
- **Endpoint**: `POST /auth/register`
- **Body**:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword123",
  "phone": "9876543210"
}
```
- **Curl Example**:
```bash
curl -X POST http://localhost:5000/api/auth/register \
     -H "Content-Type: application/json" \
     -d '{"name": "John Doe", "email": "john@example.com", "password": "securepassword123", "phone": "9876543210"}'
```

### 2. Login User
Logs in a user and returns an access token. Supports forceful login if already logged in elsewhere.
- **Endpoint**: `POST /auth/login`
- **Body**:
```json
{
  "email": "john@example.com",
  "password": "securepassword123",
  "force": 0
}
```
- **Curl Example**:
```bash
curl -X POST http://localhost:5000/api/auth/login \
     -H "Content-Type: application/json" \
     -d '{"email": "john@example.com", "password": "securepassword123", "force": 0}'

# If already logged in, returns 409:
# { "message": "User already logged in another device", "status": 1 }
```

### 3. Refresh Token
Exchanges a valid refresh token for a new access token and a new refresh token (rotation).
- **Endpoint**: `POST /auth/refresh`
- **Body**: (Optional if cookies are sent)
```json
{
  "refreshToken": "YOUR_RAW_REFRESH_TOKEN"
}
```
- **Curl Example**:
```bash
curl -X POST http://localhost:5000/api/auth/refresh \
     -H "Content-Type: application/json" \
     -d '{"refreshToken": "YOUR_RAW_REFRESH_TOKEN"}'
```

### 4. Logout User
Invalidates the current session.
- **Endpoint**: `POST /auth/logout`
- **Curl Example**:
```bash
curl -X POST http://localhost:5000/api/auth/logout \
     -H "Content-Type: application/json" \
     -b "refreshToken=YOUR_REFRESH_TOKEN"
```

---

## Company Management Endpoints

### 5. Get My Companies
Returns companies mapped to the currently logged-in user.
- **Endpoint**: `GET /company/my-companies`
- **Headers**: Requires `Authorization: Bearer <accessToken>` or cookies.
- **Curl Example**:
```bash
curl -X GET http://localhost:5000/api/company/my-companies \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 6. Get Group Companies
Returns all group companies and their associated child companies.
- **Endpoint**: `GET /company/groups`
- **Curl Example**:
```bash
curl -X GET http://localhost:5000/api/company/groups \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

### 7. Register Group & Companies
Registers a new group company along with multiple child companies.
- **Endpoint**: `POST /company/register-group`
- **Body**:
```json
{
  "group_name": "Tech Conglomerate",
  "group_code": "TC001",
  "companies": [
    {
      "company_code": "SFT01",
      "brand_name": "Soft Solutions",
      "legal_name": "Soft Solutions Pvt Ltd",
      "gst_number": "27AAAAA1234A1Z1",
      "address": "123 Tech Park, Mumbai",
      "registration_date": "2023-01-01"
    }
  ]
}
```
- **Curl Example**:
```bash
curl -X POST http://localhost:5000/api/company/register-group \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
     -d '{
          "group_name": "Tech Conglomerate",
          "group_code": "TC001",
          "companies": [
            {
              "company_code": "SFT01",
              "brand_name": "Soft Solutions"
            }
          ]
        }'
```

---

## Notes
- **Cookies**: The API uses HTTP-only cookies for `accessToken`, `refreshToken`, and `versionHash` by default.
- **Security**: Database IDs are never returned in JSON responses. Identity is managed via `company_code`, `group_code`, and secure sessions.
- **Error Scenarios**:
    - **Session Hijacking / Simultaneous Login**: 
      Returns `401 Unauthorized` with message: `"User already logged in another device"`.
      Occurs when a token's version hash doesn't match the current active version in the DB.
    - **Invalid / Expired Session**:
      Returns `401 Unauthorized` with message: `"Unauthorized - Invalid token"`.
      Occurs when the JWT is invalid, expired, or the session has been cleared from the backend.
- **Log Management**: Backend logs suppress stack traces for 4xx errors to keep the console clean.
