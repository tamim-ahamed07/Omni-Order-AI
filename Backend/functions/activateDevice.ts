import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ZodError } from "zod";
import { HTTP_STATUS } from "../config/constants";
import { exchangeActivationCode, parseActivationExchangeRequest } from "../services/deviceAuthService";
import { getStoreInfoById } from "../shared/catalogStore";
import { getErrorDetails } from "../shared/sqlClient";

async function activateDeviceHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    try {
        const body = parseActivationExchangeRequest(await request.json());
        const result = await exchangeActivationCode({
            activationCode: body.activationCode,
        });
        const store = await getStoreInfoById(result.device.storeId);

        context.log(`activateDevice: deviceId=${result.device.id}, storeId=${result.device.storeId}`);
        return {
            status: HTTP_STATUS.OK,
            jsonBody: {
                device: result.device,
                deviceToken: result.deviceToken,
                store: store
                    ? {
                        id: store.id,
                        name: store.name,
                        settings: store.settings,
                    }
                    : null,
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

        if (error instanceof Error && error.message === "Activation code is invalid or expired") {
            return {
                status: HTTP_STATUS.BAD_REQUEST,
                jsonBody: { error: error.message },
            };
        }

        context.error("activateDevice failed", { error: getErrorDetails(error) });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Failed to activate device" },
        };
    }
}

app.http("activateDevice", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "device/activate",
    handler: activateDeviceHandler,
});
