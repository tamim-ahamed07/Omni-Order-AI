import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HTTP_STATUS } from "../config/constants";
import { getStoreInfoBySlug, projectStorefront } from "../shared/catalogStore";

export async function getPublicStorefront(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    const slug = request.params.slug?.trim();

    if (!slug) {
        return {
            status: HTTP_STATUS.BAD_REQUEST,
            jsonBody: { error: "Missing store slug" },
        };
    }

    const store = await getStoreInfoBySlug(slug);
    if (!store) {
        return {
            status: HTTP_STATUS.NOT_FOUND,
            jsonBody: { error: `Store ${slug} not found` },
        };
    }

    context.log(`getPublicStorefront: slug=${slug}, storeId=${store.id}`);
    return {
        status: HTTP_STATUS.OK,
        jsonBody: {
            ...projectStorefront(store),
            capabilities: {
                queueWhenClosed: true,
            },
        },
    };
}

app.http("getPublicStorefront", {
    methods: ["GET"],
    authLevel: "anonymous",
    route: "public/stores/{slug}/storefront",
    handler: getPublicStorefront,
});
