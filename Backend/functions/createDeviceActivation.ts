import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ZodError } from "zod";
import { HTTP_STATUS } from "../config/constants";
import { createOwnerDeviceActivation, parseCreateDeviceActivationRequest } from "../services/deviceAuthService";
import { ownerUnauthorizedResponse, parseStoreId, requireOwnerAccessForStore } from "./ownerAuthHelpers";

async function createDeviceActivationHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeId = parseStoreId(request.params.storeId);
    if (storeId === null) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const hasOwnerAccess = await requireOwnerAccessForStore(request, storeId);
    if (!hasOwnerAccess) {
        return ownerUnauthorizedResponse();
    }

    try {
        const body = parseCreateDeviceActivationRequest(await request.json());
        const activation = await createOwnerDeviceActivation({
            storeId,
            deviceName: body.deviceName,
        });

        context.log(`createDeviceActivation: storeId=${storeId}, activationId=${activation.activationId}`);
        return {
            status: HTTP_STATUS.OK,
            jsonBody: activation,
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

        if (error instanceof Error && error.message.startsWith("Store ")) {
            return {
                status: HTTP_STATUS.NOT_FOUND,
                jsonBody: { error: error.message },
            };
        }

        context.error("createDeviceActivation failed", {
            storeId,
            error,
        });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to create device activation" },
        };
    }
}

app.http("createDeviceActivation", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "stores/{storeId}/device-activations",
    handler: createDeviceActivationHandler,
});
