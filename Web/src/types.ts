export type OrderStatus =
  | "new"
  | "queued_for_open"
  | "accepted"
  | "in_progress"
  | "ready"
  | "completed"
  | "cancelled";

export type PaymentStatus = "unpaid" | "paid" | "cancelled" | "expired";

export interface PublicOrderStatusResponse extends Omit<OrderSummary, "itemCount" | "customerPhone"> {
  subtotal: number;
  feeTotal: number;
  tax: number;
  fulfillmentType: string;
  items: OrderLineItem[];
  history: OrderStatusHistoryEntry[];
}

export interface StoreFeeConfig {
  code: string;
  label: string;
  amount: number;
  enabled: boolean;
  taxable: boolean;
}

export interface StorePricing {
  taxRate: number;
  fees: StoreFeeConfig[];
}

export interface StoreSettings {
  isOpen: boolean;
  showUnpaidOrders: boolean;
}

export interface StoreSummary {
  id: number;
  slug?: string;
  name: string;
  address?: string;
  hours?: Record<string, string>;
  settings: StoreSettings;
  pricing: StorePricing;
}

export interface StorefrontMenuChoice {
  id: string;
  name: string;
  price: number;
  isDefault: boolean;
}

export interface StorefrontMenuOption {
  id: string;
  name: string;
  choices: StorefrontMenuChoice[];
}

export interface StorefrontMenuAddOn {
  id: string;
  name: string;
  price: number;
}

export interface StorefrontMenuItem {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  price: number;
  isAvailable: boolean;
  displayOrder?: number;
  options: StorefrontMenuOption[];
  addOns: StorefrontMenuAddOn[];
}

export interface StorefrontMenuCategory {
  id: string;
  name: string;
  description?: string;
  imageUrl?: string;
  displayOrder?: number;
  items: StorefrontMenuItem[];
}

export interface StorefrontResponse {
  store: StoreSummary & {
    slug: string;
    heroImageUrl: string | null;
  };
  menuVersion: string;
  menu: {
    categories: StorefrontMenuCategory[];
  };
  capabilities: {
    queueWhenClosed: boolean;
  };
}

export interface RequestedOptionSelection {
  optionId: string;
  choiceId: string;
}

export interface RequestedMenuItem {
  itemId: string;
  quantity: number;
  selectedOptions: RequestedOptionSelection[];
  selectedAddOns: string[];
}

export interface StorefrontCheckoutResponse {
  orderId: string;
  checkoutUrl: string;
  expiresAt: number;
  queuedForOpen: boolean;
}

export interface DeviceRecord {
  id: string;
  storeId: number;
  name: string;
  status: "active" | "revoked";
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface OrderLineItem {
  itemId: string;
  itemName: string;
  quantity: number;
  price: number;
  selectedOptions: Array<{
    optionId: string;
    optionName?: string;
    choiceId: string;
    choiceName?: string;
    choicePrice: number;
  }>;
}

export interface OrderSummary {
  id: string;
  storeId: number;
  storeName: string;
  customerPhone: string;
  customerName: string | null;
  total: number;
  currency: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface OrderDetail extends Omit<OrderSummary, "itemCount"> {
  items: OrderLineItem[];
}

export interface OrderStatusHistoryEntry {
  id: number;
  orderId: string;
  status: OrderStatus;
  note: string | null;
  changedAt: string;
}

export interface DeviceBootstrapResponse {
  device: DeviceRecord;
  store: StoreSummary;
  menuVersion: string;
  orders: OrderSummary[];
}

export interface OwnerDevicesResponse {
  store: Pick<StoreSummary, "id" | "name">;
  devices: DeviceRecord[];
}

export interface CreateDeviceActivationResponse {
  activationId: string;
  activationCode: string;
  expiresAt: string;
}

export interface ActivateDeviceResponse {
  device: DeviceRecord;
  deviceToken: string;
  store: Pick<StoreSummary, "id" | "name" | "settings"> | null;
}
