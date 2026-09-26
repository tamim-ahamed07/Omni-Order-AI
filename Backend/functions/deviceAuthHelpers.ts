import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { DeviceRecord } from "../shared/sqlClient";
import { authenticateDeviceForStore, authenticateDeviceRequest } from "../services/deviceAuthService";

export function parseStoreId(storeIdParam: string | undefined): number | null {
    if (!storeIdParam) {
        return null;
    }

    const storeId = Number.parseInt(storeIdParam, 10);
    return Number.isNaN(storeId) ? null : storeId;
}

export function deviceUnauthorizedResponse(): HttpResponseInit {
    return {
        status: HTTP_STATUS.UNAUTHORIZED,
        jsonBody: { error: "Missing or invalid device token" },
    };
}

export async function requireAuthenticatedDevice(request: HttpRequest): Promise<DeviceRecord | null> {
    return await authenticateDeviceRequest(request);
}

export async function requireDeviceForStore(
    request: HttpRequest,
    storeId: number
): Promise<DeviceRecord | null> {
    return await authenticateDeviceForStore(request, storeId);
}
