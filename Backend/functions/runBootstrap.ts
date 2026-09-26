import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { runApplicationBootstrap } from "../shared/bootstrapService";
import { getErrorDetails } from "../shared/sqlClient";

async function runBootstrapHandler(_request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    try {
        const result = await runApplicationBootstrap(context);
        context.log("runBootstrap completed", result);

        return {
            status: HTTP_STATUS.OK,
            jsonBody: {
                message: "Bootstrap completed",
                result,
            },
        };
    } catch (error) {
        context.error("runBootstrap failed", { error: getErrorDetails(error) });
        return {
            status: HTTP_STATUS.INTERNAL_SERVER_ERROR,
            jsonBody: { error: "Bootstrap failed" },
        };
    }
}

app.http("runBootstrap", {
    methods: ["POST"],
    authLevel: "function",
    route: "ops/bootstrap",
    handler: runBootstrapHandler,
});
