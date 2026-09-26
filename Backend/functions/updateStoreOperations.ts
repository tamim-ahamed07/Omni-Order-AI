import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ZodError } from "zod";
import { HTTP_STATUS } from "../config/constants";
import { setStoreOpenState, updateStoreOperationsRequestSchema } from "../services/storeOperationsService";
import { deviceUnauthorizedResponse, parseStoreId, requireDeviceForStore } from "./deviceAuthHelpers";

async function updateStoreOperationsHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const device = await requireDeviceForStore(request, storeId);
    if (!device) {
        return deviceUnauthorizedResponse();
    }

    try {
        const body = updateStoreOperationsRequestSchema.parse(await request.json());
        const store = await setStoreOpenState({
            storeId,
            isOpen: body.isOpen,
        });

        if (!store) {
            return { status: HTTP_STATUS.NOT_FOUND, jsonBody: { error: `Store ${storeId} not found` } };
        }

        context.log(`updateStoreOperations: deviceId=${device.id}, storeId=${storeId}, isOpen=${body.isOpen}`);
        return {
            status: HTTP_STATUS.OK,
            jsonBody: {
                device,
                store: {
                    id: store.id,
                    name: store.name,
                    settings: store.settings,
                },
            },
        };
    } catch (error) {
        if (error instanceof ZodError) {
            return {
                status: HTTP_STATUS.BAD_REQUEST,
                jsonBody: {
                    error: "Invalid request body",
                    issues: error.issues,
                },
            };
        }

        context.error("updateStoreOperations failed", {
            storeId,
            error,
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to update store operations" },
        };
    }
}

app.http("updateStoreOperations", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "stores/{storeId}/operations",
    handler: updateStoreOperationsHandler,
});
