import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes, matchPath, useLocation } from "react-router-dom";
import { DeviceActivationPage } from "./pages/DeviceActivationPage";
import { DeviceDashboardPage } from "./pages/DeviceDashboardPage";
import { OrderSuccessPage } from "./pages/OrderSuccessPage";
import { OwnerPortalPage } from "./pages/OwnerPortalPage";
import { StorefrontPage } from "./pages/StorefrontPage";
import { getDeviceToken } from "./lib/storage";

const APP_TITLE = "OmniOrderAI";

function getPageTitle(pathname: string): string {
  if (matchPath("/owner", pathname)) {
    return `Restaurant Hub | ${APP_TITLE}`;
  }

  if (matchPath("/device/activate", pathname) || matchPath("/device", pathname)) {
    return `Device Setup | ${APP_TITLE}`;
  }

  if (matchPath("/device/dashboard", pathname)) {
    return `Live Service Board | ${APP_TITLE}`;
  }

  if (matchPath("/stores/:slug/order/success", pathname)) {
    return `Payment Confirmed | ${APP_TITLE}`;
  }

  if (matchPath("/stores/:slug/order", pathname)) {
    return `Order Online | ${APP_TITLE}`;
  }

  if (matchPath("/", pathname)) {
    return APP_TITLE;
  }

  return `Page Not Found | ${APP_TITLE}`;
}

function DeviceEntryRedirect() {
  return getDeviceToken() ? (
    <Navigate to="/device/dashboard" replace />
  ) : (
    <Navigate to="/device/activate" replace />
  );
}

function NotFoundPage() {
  return (
    <section className="hero-panel hero-panel-centered">
      <div className="eyebrow">OmniOrderAI</div>
      <h2>Page not found</h2>
      <p className="hero-copy">Use the restaurant hub or the device flow to continue.</p>
    </section>
  );
}

export default function App() {
  const location = useLocation();
  const isDashboardRoute = location.pathname.startsWith("/device/dashboard");
  const isStorefrontRoute =
    matchPath("/stores/:slug/order", location.pathname) !== null ||
    matchPath("/stores/:slug/order/success", location.pathname) !== null;

  useEffect(() => {
    document.title = getPageTitle(location.pathname);
  }, [location.pathname]);

  return (
    <div className={isDashboardRoute ? "app-shell app-shell-dashboard" : "app-shell"}>
      {!isDashboardRoute && !isStorefrontRoute ? (
        <header className="topbar">
          <div className="topbar-brand">
            <div className="brand-mark" aria-hidden="true">
              OO
            </div>
            <div className="topbar-copy">
              <p className="eyebrow">OmniOrderAI</p>
              <h1>Restaurant service operations</h1>
              <p className="field-hint">Take orders. Keep service moving.</p>
            </div>
          </div>
          <nav className="topbar-nav" aria-label="Primary">
            <NavLink
              to="/device"
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              Device
            </NavLink>
            <NavLink
              to="/owner"
              className={({ isActive }) => (isActive ? "nav-link active" : "nav-link")}
            >
              Restaurant hub
            </NavLink>
          </nav>
        </header>
      ) : null}

      <main className={isDashboardRoute ? "main-shell dashboard-main-shell" : isStorefrontRoute ? "main-shell storefront-main-shell" : "main-shell"}>
        <Routes>
          <Route path="/" element={<Navigate to="/device" replace />} />
          <Route path="/owner" element={<OwnerPortalPage />} />
          <Route path="/stores/:slug/order" element={<StorefrontPage />} />
          <Route path="/stores/:slug/order/success" element={<OrderSuccessPage />} />
          <Route path="/device" element={<DeviceEntryRedirect />} />
          <Route path="/device/activate" element={<DeviceActivationPage />} />
          <Route path="/device/dashboard" element={<DeviceDashboardPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>
    </div>
  );
}
