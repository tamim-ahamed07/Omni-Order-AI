import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { listOwnerDevices } from "../services/deviceAuthService";
import { getStoreInfoById } from "../shared/catalogStore";
import { ownerUnauthorizedResponse, parseStoreId, requireOwnerAccessForStore } from "./ownerAuthHelpers";

async function listStoreDevicesHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const hasOwnerAccess = await requireOwnerAccessForStore(request, storeId);
    if (!hasOwnerAccess) {
        return ownerUnauthorizedResponse();
    }

    const store = await getStoreInfoById(storeId);
    if (!store) {
        return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Store ${storeId} not found` } };
    }

    const devices = await listOwnerDevices(storeId);
    context.log(`listStoreDevices: storeId=${storeId}, devices=${devices.length}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            store: {
                id: store.id,
                name: store.name,
            },
            devices,
        },
    };
}

app.http("listStoreDevices", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "stores/{storeId}/devices",
    handler: listStoreDevicesHandler,
});
