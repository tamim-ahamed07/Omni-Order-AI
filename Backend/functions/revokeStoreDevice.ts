import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { revokeOwnerDevice } from "../services/deviceAuthService";
import { ownerUnauthorizedResponse, parseStoreId, requireOwnerAccessForStore } from "./ownerAuthHelpers";

async function revokeStoreDeviceHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const hasOwnerAccess = await requireOwnerAccessForStore(request, storeId);
    if (!hasOwnerAccess) {
        return ownerUnauthorizedResponse();
    }

    const deviceId = request.params.deviceId;
    if (!deviceId) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Missing deviceId" } };
    }

    const device = await revokeOwnerDevice({ storeId, deviceId });
    if (!device) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Device ${deviceId} not found for store ${storeId}` } };
    }

    context.log(`revokeStoreDevice: storeId=${storeId}, deviceId=${deviceId}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: { device },
    };
}

app.http("revokeStoreDevice", {
    methods: ["DELETE"],
    authLevel: "anonymous",
    route: "stores/{storeId}/devices/{deviceId}",
    handler: revokeStoreDeviceHandler,
});
