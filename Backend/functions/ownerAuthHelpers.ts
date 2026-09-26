import { HttpRequest, HttpResponseInit } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { validateStoreOwnerAccessKey } from "../shared/catalogStore";
import { parseStoreId } from "./deviceAuthHelpers";

function getOwnerAccessKeyFromRequest(request: HttpRequest): string | null {
    const explicitHeader = request.headers.get("x-owner-access-key")?.trim();
    if (explicitHeader) {
        return explicitHeader;
    }

    const authorization = request.headers.get("authorization");
    if (authorization?.startsWith("Bearer ")) {
        const bearerValue = authorization.slice("Bearer ".length).trim();
        return bearerValue || null;
    }

    return null;
}

export function ownerUnauthorizedResponse(): HttpResponseInit {
    return {
        status: HTTP_STATUS.UNAUTHORIZED,
        jsonBody: { error: "Missing or invalid restaurant access code" },
    };
}

export async function requireOwnerAccessForStore(
    request: HttpRequest,
    storeId: number
): Promise<boolean> {
    const accessKey = getOwnerAccessKeyFromRequest(request);
    if (!accessKey) {
        return false;
    }

    return await validateStoreOwnerAccessKey(storeId, accessKey);
}

export { parseStoreId };
