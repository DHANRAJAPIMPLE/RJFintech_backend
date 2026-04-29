# API Documentation

This document provides details for the Middle-Layer APIs (Port 5000). All APIs require `Content-Type: application/json`. Most protected APIs require an `Authorization` cookie (JWT).

---

## 1. Authentication Module

### Register User
- **Endpoint**: `POST /api/v1/auth/register`
- **Request Body**:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "securepassword123",
  "phone": "9876543210"
}
```
- **Success Response (201)**:
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "uuid",
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

### Login User
- **Endpoint**: `POST /api/v1/auth/login`
- **Request Body**:
```json
{
  "email": "admin@globaltech.com",
  "password": "Admin@123",
  "force": 0
}
```
- **Success Response (200)**: Sets `accessToken` and `refreshToken` cookies.
```json
{
  "message": "Login successful",
  "user": {
    "id": "uuid",
    "email": "admin@globaltech.com",
    "name": "Super Admin",
    "companies": [...]
  }
}
```

### Get Current User (Me)
- **Endpoint**: `GET /api/v1/auth/me`
- **Success Response (200)**:
```json
{
  "user": {
    "id": "uuid",
    "email": "admin@globaltech.com",
    "name": "Super Admin",
    "companies": [...]
  }
}
```

---

## 2. Onboarding Module

### Initiate Company Onboarding
- **Endpoint**: `POST /api/v1/company-settings/initiate`
- **Request Body**:
```json
{
  "group": {
    "name": "New Group",
    "groupCode": "OptionalCode",
    "remarks": "Notes"
  },
  "company": {
    "name": "New Company Ltd",
    "companyCode": "OptionalCode",
    "gst": "27AAAAA0000A1Z5",
    "brand": "BrandName",
    "ieCode": "IE123",
    "address": "Company Address",
    "registeredAt": "2024-04-27"
  },
  "signatories": [
    {
      "name": "Manager Name",
      "email": "manager@example.com",
      "phone": "9876543211",
      "designation": "Director",
      "employeeId": "EMP002"
    }
  ]
}
```
- **Success Response (201)**:
```json
{
  "message": "Onboarding initiated successfully",
  "companyCode": "GTSOL00127042026",
  "groupCode": "NEWGROUP27042026"
}
```

### Action Company Onboarding (Approve/Reject)
- **Endpoint**: `POST /api/v1/company-settings/action`
- **Request Body**:
```json
{
  "id": "onboarding-uuid",
  "action": "approve",
  "remark": "Looks good"
}
```

### Initiate User Onboarding
- **Endpoint**: `POST /api/v1/company-settings/user/action`
- **Request Body**:
```json
{
  "id": "-uuid",
  "action": "approve",
  "remark": "Looks good"
}
```


### Initiate User Onboarding
- **Endpoint**: `POST /api/v1/company-settings/user/initiate`
- **Request Body**:
```json
{
  "basicDetails": {
    "name": "User Name",
    "email": "user@example.com",
    "phone": "9876543212",
    "reportingManager": "admin@globaltech.com",
    "designation": "Executive",
    "employeeId": "EMP003"
  },
  "permissions": [
    {
      "accessType": "PRIMARY",
      "roleName": "Administrator",
      "nodePath": "GTSOL001.ROOT"
    }
  ]
}
```

---

## 3. Organization Structure Module

### Initiate Org Request
- **Endpoint**: `POST /api/v1/company-settings/org/initiate`
- **Request Body**:
```json
{
  "companyCode": "GTSOL001",
  "newNodeName": "Sales Department",
  "nodeType": "DEPARTMENT",
  "parentNode": {
    "nodePath": "GTSOL001.ROOT"
  }
}
```

### Approve Org Request
- **Endpoint**: `POST /api/v1/company-settings/org/approve`
- **Request Body**:
```json
{
  "id": "request-uuid",
  "action": "approve",
  "remark": "Approved"
}
```

### Fetch Org Structure
- **Endpoint**: `POST /api/v1/company-settings/org/fetch`
- **Request Body**:
```json
{
  "companyCode": "GTSOL001"
}
```
- **Success Response (200)**:
```json
{
  "message": "Organization structure fetched successfully!",
  "code": 200,
  "data": [
    {
      "nodeName": "Global Tech Solutions",
      "nodeType": "ROOT",
      "nodePath": "GTSOL001.ROOT"
    },
    {
      "nodeName": "Sales Department",
      "nodeType": "DEPARTMENT",
      "nodePath": "GTSOL001.ROOT.SALES_DEPARTMENT"
    }
  ]
}
```

---

## 4. Admin & Management

### Fetch All Users
- **Endpoint**: `GET /api/v1/company-settings/user/fetch-all`
- **Success Response (200)**:
```json
{
  "message": "Users fetched successfully!",
  "code": 200,
  "data": {
    "activeUsers": [...],
    "pendingUsers": [
        {
            "id": "uuid",
            "basicDetails": { ... },
            "primary": [...],
            "secondary": [...]
        }
    ],
    "inactiveUsers": [...]
  }
}
```

### Fetch Groups & Companies
- **Endpoint**: `GET /api/v1/admin/groups`
- **Success Response (200)**:
```json
{
  "message": "Companies fetched successfully!",
  "companies": {
    "active": [...],
    "pending": [...],
    "inactive": [...]
  }
}
```


```
