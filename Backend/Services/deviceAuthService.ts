import { HttpRequest } from "@azure/functions";
import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { DEVICE_ACTIVATION_TTL_MS } from "../config/constants";
import {
    activateDeviceFromCode,
    createDeviceActivationSession,
    DeviceRecord,
    getActiveDeviceByTokenHash,
    listDevicesByStore,
    revokeDevice,
    touchDeviceLastSeen,
} from "../shared/sqlClient";
import { getStoreInfoById } from "../shared/catalogStore";

const activationRequestSchema = z.object({
    deviceName: z.string().trim().min(1).max(120),
});

const activationExchangeSchema = z.object({
    activationCode: z.string().trim().min(6).max(64),
});

function hashToken(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function generateId(prefix: string): string {
    return `${prefix}_${Date.now()}_${randomBytes(6).toString("hex")}`;
}

function generateActivationCode(): string {
    return randomBytes(5).toString("hex").toUpperCase();
}

function generateDeviceToken(): string {
    return randomBytes(32).toString("base64url");
}

export function parseCreateDeviceActivationRequest(body: unknown): { deviceName: string } {
    return activationRequestSchema.parse(body);
}

export function parseActivationExchangeRequest(body: unknown): { activationCode: string } {
    return activationExchangeSchema.parse(body);
}

export async function createOwnerDeviceActivation(input: {
    storeId: number;
    deviceName: string;
}): Promise<{
    activationId: string;
    activationCode: string;
    expiresAt: string;
}> {
    const store = await getStoreInfoById(input.storeId);
    if (!store) {
        throw new Error(`Store ${input.storeId} not found`);
    }

    const activationId = generateId("dact");
    const activationCode = generateActivationCode();
    const expiresAt = new Date(Date.now() + DEVICE_ACTIVATION_TTL_MS);

    await createDeviceActivationSession({
        id: activationId,
        storeId: input.storeId,
        deviceName: input.deviceName,
        activationCodeHash: hashToken(activationCode),
        expiresAt,
    });

    return {
        activationId,
        activationCode,
        expiresAt: expiresAt.toISOString(),
    };
}

export async function exchangeActivationCode(input: {
    activationCode: string;
}): Promise<{
    device: DeviceRecord;
    deviceToken: string;
}> {
    const deviceId = generateId("dev");
    const deviceToken = generateDeviceToken();
    const device = await activateDeviceFromCode({
        deviceId,
        deviceTokenHash: hashToken(deviceToken),
        activationCodeHash: hashToken(input.activationCode.trim().toUpperCase()),
    });

    if (!device) {
        throw new Error("Activation code is invalid or expired");
    }

    return { device, deviceToken };
}

export async function authenticateDeviceRequest(request: HttpRequest): Promise<DeviceRecord | null> {
    const authorization = request.headers.get("authorization");
    const bearerToken = authorization?.startsWith("Bearer ")
        ? authorization.slice("Bearer ".length).trim()
        : null;
    const explicitToken = request.headers.get("x-device-token")?.trim() ?? null;
    const token = bearerToken || explicitToken;

    if (!token) {
        return null;
    }

    const device = await getActiveDeviceByTokenHash(hashToken(token));
    if (!device) {
        return null;
    }

    await touchDeviceLastSeen(device.id);
    return device;
}

export async function authenticateDeviceForStore(
    request: HttpRequest,
    storeId: number
): Promise<DeviceRecord | null> {
    const device = await authenticateDeviceRequest(request);
    if (!device || device.storeId !== storeId) {
        return null;
    }

    return device;
}

export async function listOwnerDevices(storeId: number): Promise<DeviceRecord[]> {
    return await listDevicesByStore(storeId);
}

export async function revokeOwnerDevice(input: {
    storeId: number;
    deviceId: string;
}): Promise<DeviceRecord | null> {
    return await revokeDevice(input);
}
