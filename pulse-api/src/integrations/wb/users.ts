/**
 * WB Users/Team API integration
 * 
 * Manage seller account users
 * Host: https://common-api.wildberries.ru
 */

import { wbGetJson, wbPostJson, wbDeleteJson } from './wbClient.js';

const BASE_URL = 'https://common-api.wildberries.ru';

// Types
export interface WbUser {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  role: string;
  permissions: string[];
  isActive: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface WbRole {
  id: number;
  name: string;
  description: string;
  permissions: string[];
  isSystem: boolean;
}

/**
 * Get list of users in seller account
 * GET /api/v1/users
 */
export async function getUsers(apiKey: string): Promise<{ users: WbUser[] }> {
  return wbGetJson(`${BASE_URL}/api/v1/users`, apiKey);
}

/**
 * Get user by ID
 * GET /api/v1/users/{userId}
 */
export async function getUser(apiKey: string, userId: number): Promise<{ user: WbUser }> {
  return wbGetJson(`${BASE_URL}/api/v1/users/${userId}`, apiKey);
}

/**
 * Invite new user
 * POST /api/v1/users/invite
 */
export async function inviteUser(
  apiKey: string,
  params: {
    email: string;
    firstName: string;
    lastName: string;
    roleId?: number;
    permissions?: string[];
  }
): Promise<{ user: WbUser }> {
  return wbPostJson(`${BASE_URL}/api/v1/users/invite`, apiKey, params);
}

/**
 * Update user
 * PATCH /api/v1/users/{userId}
 */
export async function updateUser(
  apiKey: string,
  userId: number,
  params: {
    firstName?: string;
    lastName?: string;
    roleId?: number;
    permissions?: string[];
    isActive?: boolean;
  }
): Promise<{ user: WbUser }> {
  const res = await fetch(`${BASE_URL}/api/v1/users/${userId}`, {
    method: 'PATCH',
    headers: {
      Authorization: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WB Users API error: ${res.status} ${text}`);
  }

  return res.json() as Promise<{ user: WbUser }>;
}

/**
 * Delete user
 * DELETE /api/v1/users/{userId}
 */
export async function deleteUser(apiKey: string, userId: number): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/users/${userId}`, {
    method: 'DELETE',
    headers: {
      Authorization: apiKey,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WB Users API error: ${res.status} ${text}`);
  }
}

/**
 * Get available roles
 * GET /api/v1/roles
 */
export async function getRoles(apiKey: string): Promise<{ roles: WbRole[] }> {
  return wbGetJson(`${BASE_URL}/api/v1/roles`, apiKey);
}

/**
 * Get available permissions
 * GET /api/v1/permissions
 */
export async function getPermissions(apiKey: string): Promise<{ permissions: Array<{ id: string; name: string; description: string; category: string }> }> {
  return wbGetJson(`${BASE_URL}/api/v1/permissions`, apiKey);
}
