import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { getStoreInfoById } from "../shared/catalogStore";
import { HTTP_STATUS } from "../config/constants";

/**
 * GET /api/stores/{storeId}
 * Returns store config + active menu. Used by the web dashboard and (future) agent.
 */
async function getStoreHandler(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const storeIdParam = req.params.storeId;
    const storeId = parseInt(storeIdParam, 10);

    if (isNaN(storeId)) {
        return { status: HTTP_STATUS.BAD_REQUEST, jsonBody: { error: "Invalid storeId — must be an integer" } };
    }

    const store = await getStoreInfoById(storeId);

    if (!store) {
        return { status: 404, jsonBody: { error: `Store ${storeId} not found` } };
    }

    context.log(`getStore: storeId=${storeId} (${store.name})`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            store: {
                id: store.id,
                name: store.name,
                address: store.address,
                hours: store.hours,
                settings: store.settings,
            },
            menu: store.menu,
            menuVersion: store.menuVersion,
        },
    };
}

app.http("getStore", {
    methods: ["GET"],
    authLevel: "function",
    route: "stores/{storeId}",
    handler: getStoreHandler,
});
