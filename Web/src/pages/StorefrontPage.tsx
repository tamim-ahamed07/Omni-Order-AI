import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { cancelStorefrontCheckoutOrder, createStorefrontCheckout, getPublicStorefront } from "../lib/api";
import { calculateStorefrontCartTotals } from "../lib/pricing";
import {
  formatCurrency,
  formatStorefrontPhoneInput,
  formatStorefrontHours,
  getNormalizedStorefrontPhone,
  getStorefrontPhoneValidationMessage,
  STOREFRONT_PHONE_COUNTRIES,
} from "../lib/format";
import {
  clearPendingCheckout,
  clearStorefrontCart,
  getPendingCheckout,
  getStorefrontCart,
  getStorefrontCustomer,
  setPendingCheckout,
  setStorefrontCart,
  setStorefrontCustomer,
  type PendingCheckout,
} from "../lib/storage";
import type {
  RequestedMenuItem,
  StorefrontMenuAddOn,
  StorefrontMenuChoice,
  StorefrontMenuItem,
  StorefrontMenuOption,
  StorefrontResponse,
} from "../types";

interface CartSelection {
  optionId: string;
  optionName?: string;
  choiceId: string;
  choiceName: string;
  choicePrice: number;
}

interface CartEntry {
  key: string;
  itemId: string;
  itemName: string;
  itemImageUrl?: string;
  quantity: number;
  basePrice: number;
  selectedOptions: CartSelection[];
}

const EMPTY_CART: CartEntry[] = [];
const ADD_ON_SELECTION_PREFIX = "add_on::";

function sortByDisplayOrder<T extends { displayOrder?: number; name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => {
    const displayOrderDiff = (left.displayOrder ?? Number.MAX_SAFE_INTEGER) - (right.displayOrder ?? Number.MAX_SAFE_INTEGER);
    return displayOrderDiff !== 0 ? displayOrderDiff : left.name.localeCompare(right.name);
  });
}

function buildCartKey(itemId: string, selectedOptions: CartSelection[]): string {
  const optionsKey = [...selectedOptions]
    .sort((left, right) => left.optionId.localeCompare(right.optionId))
    .map((selection) => `${selection.optionId}:${selection.choiceId}`)
    .join("|");

  return `${itemId}::${optionsKey}`;
}

function getAddOnSelectionId(addOnId: string): string {
  return `${ADD_ON_SELECTION_PREFIX}${addOnId}`;
}

function isAddOnSelection(selection: CartSelection): boolean {
  return selection.optionId.startsWith(ADD_ON_SELECTION_PREFIX);
}

function getDefaultSelections(options: StorefrontMenuOption[]): Record<string, string> {
  return Object.fromEntries(
    options.map((option) => [
      option.id,
      option.choices.find((choice) => choice.isDefault)?.id ?? option.choices[0]?.id ?? "",
    ]),
  );
}

function resolveSelectedOptions(
  options: StorefrontMenuOption[],
  selectedChoiceIds: Record<string, string>,
): CartSelection[] {
  return options.flatMap((option) => {
    const selectedChoice = option.choices.find((choice) => choice.id === selectedChoiceIds[option.id]);
    if (!selectedChoice) {
      return [];
    }

    return [{
      optionId: option.id,
      optionName: option.name,
      choiceId: selectedChoice.id,
      choiceName: selectedChoice.name,
      choicePrice: selectedChoice.price,
    }];
  });
}

function resolveSelectedAddOns(
  addOns: StorefrontMenuAddOn[],
  selectedAddOnIds: string[],
): CartSelection[] {
  const selected = new Set(selectedAddOnIds);
  return addOns.flatMap((addOn) => {
    if (!selected.has(addOn.id)) {
      return [];
    }

    return [{
      optionId: getAddOnSelectionId(addOn.id),
      choiceId: addOn.id,
      choiceName: addOn.name,
      choicePrice: addOn.price,
    }];
  });
}

function getLineTotal(entry: CartEntry): number {
  const optionTotal = entry.selectedOptions.reduce((sum, selection) => sum + selection.choicePrice, 0);
  return (entry.basePrice + optionTotal) * entry.quantity;
}

function toRequestedItems(cart: CartEntry[]): RequestedMenuItem[] {
  return cart.map((entry) => ({
    itemId: entry.itemId,
    quantity: entry.quantity,
    selectedOptions: entry.selectedOptions
      .filter((selection) => !isAddOnSelection(selection))
      .map((selection) => ({
        optionId: selection.optionId,
        choiceId: selection.choiceId,
      })),
    selectedAddOns: entry.selectedOptions
      .filter((selection) => isAddOnSelection(selection))
      .map((selection) => selection.choiceId),
  }));
}

function getChoiceLabel(choice: Pick<StorefrontMenuChoice, "name" | "price">): string {
  if (choice.price <= 0) {
    return choice.name;
  }

  return `${choice.name} (+${formatCurrency(choice.price)})`;
}

function getItemImage(item: StorefrontMenuItem, categoryImageUrl?: string, heroImageUrl?: string | null): string | undefined {
  return item.imageUrl ?? categoryImageUrl ?? heroImageUrl ?? undefined;
}

export function StorefrontPage() {
  const { slug } = useParams<{ slug: string }>();
  const [storefront, setStorefront] = useState<StorefrontResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState("");
  const [selectedItem, setSelectedItem] = useState<StorefrontMenuItem | null>(null);
  const [selectedCategoryImage, setSelectedCategoryImage] = useState<string | undefined>(undefined);
  const [selectedChoices, setSelectedChoices] = useState<Record<string, string>>({});
  const [selectedAddOnIds, setSelectedAddOnIds] = useState<string[]>([]);
  const [selectedQuantity, setSelectedQuantity] = useState(1);
  const [cart, setCart] = useState<CartEntry[]>(() => (slug ? getStorefrontCart<CartEntry[]>(slug) ?? EMPTY_CART : EMPTY_CART));
  const [cartOpen, setCartOpen] = useState(false);
  const [customerName, setCustomerName] = useState(() => (slug ? getStorefrontCustomer(slug)?.name ?? "" : ""));
  const [phoneCountryId, setPhoneCountryId] = useState(() => (slug ? getStorefrontCustomer(slug)?.phoneCountryId ?? "US" : "US"));
  const [customerPhone, setCustomerPhone] = useState(() => (slug ? getStorefrontCustomer(slug)?.phone ?? "" : ""));
  const [phoneValidationError, setPhoneValidationError] = useState("");
  const [checkoutError, setCheckoutError] = useState("");
  const [submittingCheckout, setSubmittingCheckout] = useState(false);
  const [pendingCheckout, setPendingCheckoutState] = useState<PendingCheckout | null>(
    () => (slug ? getPendingCheckout(slug) : null)
  );
  // Tracks cart initialisation for the current slug. The slug effect triggers two cart renders:
  // one from the initial useState value and one from the setCart call in the slug effect (new
  // JSON.parse reference). Both must be skipped before treating cart changes as user edits.
  const cartInitialisedRef = useRef(0);

  useEffect(() => {
    if (!slug) {
      setLoading(false);
      setErrorMessage("Missing storefront slug.");
      return;
    }

    cartInitialisedRef.current = 0;
    setCart(getStorefrontCart<CartEntry[]>(slug) ?? EMPTY_CART);
    setPendingCheckoutState(getPendingCheckout(slug));
    setLoading(true);
    setErrorMessage("");

    void (async () => {
      try {
        const response = await getPublicStorefront(slug);
        setStorefront(response);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Failed to load storefront");
      } finally {
        setLoading(false);
      }
    })();
  }, [slug]);

  // When the cart changes after the initial load, immediately cancel any pending unpaid order.
  // This covers adding items, removing items, or changing quantities — all are treated as a new order.
  useEffect(() => {
    if (cartInitialisedRef.current < 2) {
      cartInitialisedRef.current++;
      return;
    }
    if (!slug || !pendingCheckout) return;

    const { orderId } = pendingCheckout;
    // Optimistically clear the pending state so the button reverts immediately.
    clearPendingCheckout(slug);
    setPendingCheckoutState(null);
    // Fire-and-forget: cancel the unpaid order on the backend.
    void cancelStorefrontCheckoutOrder(orderId).catch(() => {
      // Cancellation failure is non-critical — the Stripe session will expire and the
      // checkout.session.expired webhook will cancel the order automatically.
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart]);

  // Restore state when browser navigates back from Stripe via bfcache.
  useEffect(() => {
    function handlePageShow(event: PageTransitionEvent) {
      if (!event.persisted || !slug) return;
      setSubmittingCheckout(false);
      setPendingCheckoutState(getPendingCheckout(slug));
    }
    window.addEventListener("pageshow", handlePageShow);
    return () => window.removeEventListener("pageshow", handlePageShow);
  }, [slug]);

  useEffect(() => {
    if (!slug) {
      return;
    }

    if (cart.length === 0) {
      clearStorefrontCart(slug);
      return;
    }

    setStorefrontCart(slug, cart);
  }, [cart, slug]);

  const categories = useMemo(
    () => (storefront ? sortByDisplayOrder(storefront.menu.categories).map((category) => ({
      ...category,
      items: sortByDisplayOrder(category.items),
    })) : []),
    [storefront],
  );
  const cartTotals = useMemo(
    () => calculateStorefrontCartTotals(cart.map((entry) => ({
      price: entry.basePrice,
      quantity: entry.quantity,
      selectedOptions: entry.selectedOptions,
    })), storefront?.store.pricing),
    [cart, storefront],
  );
  const isStoreClosed = storefront ? !storefront.store.settings.isOpen : false;
  const selectedPhoneCountry = useMemo(
    () => STOREFRONT_PHONE_COUNTRIES.find((country) => country.id === phoneCountryId) ?? STOREFRONT_PHONE_COUNTRIES[0],
    [phoneCountryId],
  );

  function openItemSheet(item: StorefrontMenuItem, categoryImageUrl?: string) {
    setSelectedItem(item);
    setSelectedCategoryImage(categoryImageUrl);
    setSelectedChoices(getDefaultSelections(item.options));
    setSelectedAddOnIds([]);
    setSelectedQuantity(1);
  }

  function closeItemSheet() {
    setSelectedItem(null);
    setSelectedCategoryImage(undefined);
    setSelectedChoices({});
    setSelectedAddOnIds([]);
    setSelectedQuantity(1);
  }

  function addItemToCart(
    item: StorefrontMenuItem,
    quantity: number,
    selectedChoiceIds: Record<string, string>,
    selectedAddOnIdsForItem: string[],
  ) {
    const nextSelections = [
      ...resolveSelectedOptions(item.options, selectedChoiceIds),
      ...resolveSelectedAddOns(item.addOns, selectedAddOnIdsForItem),
    ];
    const nextEntry: CartEntry = {
      key: buildCartKey(item.id, nextSelections),
      itemId: item.id,
      itemName: item.name,
      itemImageUrl: item.imageUrl,
      quantity,
      basePrice: item.price,
      selectedOptions: nextSelections,
    };

    setCart((currentCart) => {
      const existingIndex = currentCart.findIndex((entry) => entry.key === nextEntry.key);
      if (existingIndex === -1) {
        return [...currentCart, nextEntry];
      }

      const nextCart = [...currentCart];
      nextCart[existingIndex] = {
        ...nextCart[existingIndex],
        quantity: nextCart[existingIndex].quantity + nextEntry.quantity,
      };
      return nextCart;
    });
    setCartOpen(true);
  }

  function addSelectedItemToCart() {
    if (!selectedItem) {
      return;
    }

    addItemToCart(selectedItem, selectedQuantity, selectedChoices, selectedAddOnIds);
    closeItemSheet();
  }

  function handleItemCardOpen(item: StorefrontMenuItem, categoryImageUrl?: string) {
    if (!item.isAvailable) {
      return;
    }

    openItemSheet(item, categoryImageUrl);
  }

  function handleItemPrimaryAction(item: StorefrontMenuItem, categoryImageUrl?: string) {
    if (!item.isAvailable) {
      return;
    }

    if (item.options.length === 0 && item.addOns.length === 0) {
      addItemToCart(item, 1, {}, []);
      return;
    }

    openItemSheet(item, categoryImageUrl);
  }

  function updateCartQuantity(key: string, delta: number) {
    setCart((currentCart) => currentCart.flatMap((entry) => {
      if (entry.key !== key) {
        return [entry];
      }

      const nextQuantity = entry.quantity + delta;
      if (nextQuantity <= 0) {
        return [];
      }

      return [{ ...entry, quantity: nextQuantity }];
    }));
  }

  async function handleCheckout(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!slug || cart.length === 0) {
      return;
    }

    const normalizedPhone = getNormalizedStorefrontPhone(customerPhone, selectedPhoneCountry);
    if (!normalizedPhone) {
      setPhoneValidationError(getStorefrontPhoneValidationMessage(selectedPhoneCountry));
      return;
    }

    setSubmittingCheckout(true);
    setPhoneValidationError("");
    setCheckoutError("");

    try {
      const result = await createStorefrontCheckout({
        slug,
        customerName: customerName.trim(),
        customerPhone: normalizedPhone,
        items: toRequestedItems(cart),
      });

      // Save customer details for next visit before navigating away.
      setStorefrontCustomer(slug, {
        name: customerName.trim(),
        phoneCountryId,
        phone: customerPhone,
      });

      // Save the pending checkout to sessionStorage (per-tab) before leaving.
      // Cart is NOT cleared here — it stays in localStorage so the user can return and edit.
      const next: PendingCheckout = {
        orderId: result.orderId,
        checkoutUrl: result.checkoutUrl,
        expiresAt: result.expiresAt,
      };
      setPendingCheckout(slug, next);
      setPendingCheckoutState(next);

      window.location.assign(result.checkoutUrl);
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "Failed to create checkout");
      setSubmittingCheckout(false);
    }
  }

  function handleResumePendingCheckout() {
    if (!pendingCheckout) return;
    window.location.assign(pendingCheckout.checkoutUrl);
  }

  if (loading) {
    return (
      <section className="storefront-page">
        <div className="storefront-loading panel">
          <p className="eyebrow">Loading storefront</p>
          <h2>Getting the latest menu ready...</h2>
        </div>
      </section>
    );
  }

  if (errorMessage || !storefront) {
    return (
      <section className="storefront-page">
        <div className="storefront-loading panel">
          <p className="eyebrow">Storefront unavailable</p>
          <h2>{errorMessage || "We could not load this restaurant."}</h2>
        </div>
      </section>
    );
  }

  return (
    <section className="storefront-page">
      <div className="storefront-shell">
        <section
          className="storefront-hero"
          style={storefront.store.heroImageUrl ? { backgroundImage: `linear-gradient(180deg, rgba(15, 23, 42, 0.18), rgba(15, 23, 42, 0.64)), url(${storefront.store.heroImageUrl})` } : undefined}
        >
          <div className="storefront-hero-content">
            <span className="storefront-badge">Order online</span>
            <h1>{storefront.store.name}</h1>
            <p>{storefront.store.address}</p>
            <div className="storefront-hero-meta">
              <span className={`status-chip ${isStoreClosed ? "cancelled" : "active"}`}>
                {isStoreClosed ? "Closed now" : "Open now"}
              </span>
              {formatStorefrontHours(storefront.store.hours).map((hoursLine) => (
                <span key={hoursLine} className="meta-pill">{hoursLine}</span>
              ))}
            </div>
            {isStoreClosed ? (
              <p className="storefront-closed-note">
                The kitchen is currently closed, but you can still build your order and pay now. We will queue it for the next opening.
              </p>
            ) : null}
          </div>
        </section>

        <div className="storefront-layout">
          <div className="storefront-content">
            <nav className="storefront-category-nav" aria-label="Menu categories">
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="storefront-category-chip"
                  onClick={() => document.getElementById(`category-${category.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                >
                  {category.name}
                </button>
              ))}
            </nav>

            <div className="storefront-menu">
              {categories.map((category) => (
                <section key={category.id} id={`category-${category.id}`} className="storefront-category-section">
                  <div className="storefront-category-header">
                    <div>
                      <p className="eyebrow">Category</p>
                      <h2>{category.name}</h2>
                      {category.description ? <p className="field-hint">{category.description}</p> : null}
                    </div>
                    {category.imageUrl ? (
                      <img className="storefront-category-image" src={category.imageUrl} alt={category.name} loading="lazy" />
                    ) : null}
                  </div>

                  <div className="storefront-item-grid">
                    {category.items.map((item) => (
                      <article key={item.id} className="storefront-item-card">
                        <div className="storefront-item-copy">
                          <div
                            className={`storefront-item-card-trigger${item.isAvailable ? "" : " storefront-item-card-trigger-disabled"}`}
                            role={item.isAvailable ? "button" : undefined}
                            tabIndex={item.isAvailable ? 0 : -1}
                            onClick={() => handleItemCardOpen(item, category.imageUrl)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleItemCardOpen(item, category.imageUrl);
                              }
                            }}
                            aria-label={item.isAvailable ? `View ${item.name}` : undefined}
                          >
                            <div className="storefront-item-topline">
                              <div>
                                <h3>{item.name}</h3>
                                <p className="storefront-item-price">{formatCurrency(item.price)}</p>
                              </div>
                              <span className={`status-chip ${item.isAvailable ? "active" : "cancelled"}`}>
                                {item.isAvailable ? "Available" : "Sold out"}
                              </span>
                            </div>
                            <p className="field-hint">{item.description ?? "Customize options and quantities before adding to cart."}</p>
                          </div>
                          <button
                            type="button"
                            className="button primary"
                            disabled={!item.isAvailable}
                            onClick={() => handleItemPrimaryAction(item, category.imageUrl)}
                          >
                            {item.options.length > 0 ? "Customize" : "Add to cart"}
                          </button>
                        </div>
                        {getItemImage(item, category.imageUrl, storefront.store.heroImageUrl) ? (
                          <div
                            className={`storefront-item-card-trigger${item.isAvailable ? "" : " storefront-item-card-trigger-disabled"}`}
                            role={item.isAvailable ? "button" : undefined}
                            tabIndex={item.isAvailable ? 0 : -1}
                            onClick={() => handleItemCardOpen(item, category.imageUrl)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                handleItemCardOpen(item, category.imageUrl);
                              }
                            }}
                            aria-label={item.isAvailable ? `View ${item.name}` : undefined}
                          >
                            <img
                              className="storefront-item-image"
                              src={getItemImage(item, category.imageUrl, storefront.store.heroImageUrl)}
                              alt={item.name}
                              loading="lazy"
                            />
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>

          <aside className={`storefront-cart ${cartOpen ? "storefront-cart-open" : ""}`}>
            <div className="storefront-cart-header">
              <div>
                <p className="eyebrow">Your cart</p>
                <h2>{cartTotals.itemCount} item{cartTotals.itemCount === 1 ? "" : "s"}</h2>
              </div>
              <button type="button" className="button subtle storefront-cart-close" onClick={() => setCartOpen(false)}>
                Close
              </button>
            </div>

            <div className="storefront-cart-body">
              {cart.length === 0 ? (
                <div className="empty-state storefront-cart-empty">
                  <h3>Your cart is empty</h3>
                  <p>Add a few favorites to see your order summary here.</p>
                </div>
              ) : (
                <>
                  <div className="storefront-cart-list">
                    {cart.map((entry) => (
                      <article key={entry.key} className="storefront-cart-item">
                        <div className="storefront-cart-item-copy">
                          <div className="storefront-cart-item-topline">
                            <h3>{entry.itemName}</h3>
                            <strong>{formatCurrency(getLineTotal(entry))}</strong>
                          </div>
                          {entry.selectedOptions.length > 0 ? (
                            <p className="field-hint">
                              {entry.selectedOptions.map((selection) => selection.choiceName).join(" · ")}
                            </p>
                          ) : null}
                        </div>
                        <div className="storefront-cart-quantity">
                          <button type="button" className="button secondary" onClick={() => updateCartQuantity(entry.key, -1)}>
                            −
                          </button>
                          <span>{entry.quantity}</span>
                          <button type="button" className="button secondary" onClick={() => updateCartQuantity(entry.key, 1)}>
                            +
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                  <div className="storefront-cart-summary">
                    <div className="storefront-summary-line">
                      <span>Subtotal</span>
                      <strong>{formatCurrency(cartTotals.subtotal)}</strong>
                    </div>
                    {cartTotals.tax + cartTotals.feeTotal > 0 ? (
                      <div className="storefront-summary-line">
                        <span>Tax &amp; fees</span>
                        <strong>{formatCurrency(cartTotals.tax + cartTotals.feeTotal)}</strong>
                      </div>
                    ) : null}
                    <div className="storefront-summary-line">
                      <span>Total</span>
                      <strong>{formatCurrency(cartTotals.total)}</strong>
                    </div>
                  </div>
                </>
              )}
            </div>
            {cart.length > 0 ? (
              <div className="storefront-cart-footer">
                <form className="storefront-checkout-form" onSubmit={handleCheckout}>
                  {!(pendingCheckout && pendingCheckout.expiresAt > Date.now()) ? (
                    <>
                      <div className="field-group">
                        <label htmlFor="storefront-name">Your name</label>
                        <input
                          id="storefront-name"
                          value={customerName}
                          onChange={(event) => setCustomerName(event.target.value)}
                          placeholder="Jane Doe"
                          required
                        />
                      </div>
                      <div className="field-group">
                        <label htmlFor="storefront-phone">Mobile number</label>
                        <div className="storefront-phone-row">
                          <select
                            id="storefront-phone-country"
                            value={phoneCountryId}
                            onChange={(event) => {
                              setPhoneCountryId(event.target.value);
                              setCustomerPhone("");
                              setPhoneValidationError("");
                            }}
                            aria-label="Country code"
                          >
                            {STOREFRONT_PHONE_COUNTRIES.map((country) => (
                              <option key={country.id} value={country.id}>
                                {country.shortLabel}
                              </option>
                            ))}
                          </select>
                          <input
                            id="storefront-phone"
                            type="tel"
                            inputMode="tel"
                            autoComplete={selectedPhoneCountry.mode === "fullInternational" ? "tel" : "tel-national"}
                            value={customerPhone}
                            onChange={(event) => {
                              setCustomerPhone(formatStorefrontPhoneInput(event.target.value, selectedPhoneCountry));
                              if (phoneValidationError) {
                                setPhoneValidationError("");
                              }
                            }}
                            onBlur={() => {
                              if (!customerPhone) {
                                setPhoneValidationError("");
                                return;
                              }

                              setPhoneValidationError(
                                getNormalizedStorefrontPhone(customerPhone, selectedPhoneCountry)
                                  ? ""
                                  : getStorefrontPhoneValidationMessage(selectedPhoneCountry),
                              );
                            }}
                            placeholder={selectedPhoneCountry.placeholder}
                            aria-invalid={phoneValidationError ? "true" : "false"}
                            required
                          />
                        </div>
                      </div>
                      {phoneValidationError ? <p className="error-text storefront-checkout-error">{phoneValidationError}</p> : null}
                    </>
                  ) : null}
                  {isStoreClosed ? (
                    <div className="storefront-queued-banner">
                      Store closed now. Paying today will queue this order for the next opening.
                    </div>
                  ) : null}
                  {checkoutError ? <p className="error-text storefront-checkout-error">{checkoutError}</p> : null}
                  {pendingCheckout && pendingCheckout.expiresAt > Date.now() ? (
                    <button
                      type="button"
                      className="button primary storefront-checkout-button"
                      disabled={submittingCheckout}
                      onClick={handleResumePendingCheckout}
                    >
                      Complete payment · {formatCurrency(cartTotals.total)}
                    </button>
                  ) : (
                    <button type="submit" className="button primary storefront-checkout-button" disabled={submittingCheckout}>
                      {submittingCheckout
                        ? "Redirecting..."
                        : isStoreClosed
                          ? `Pay & queue order · ${formatCurrency(cartTotals.total)}`
                          : `Proceed to payment · ${formatCurrency(cartTotals.total)}`}
                    </button>
                  )}
                </form>
              </div>
            ) : null}
          </aside>
        </div>
      </div>

      {selectedItem ? (
        <>
          <button type="button" className="drawer-backdrop" aria-label="Close item details" onClick={closeItemSheet} />
          <section className="storefront-item-sheet panel" aria-label={`${selectedItem.name} options`}>
            <div className="storefront-item-sheet-header">
              <div>
                <p className="eyebrow">Customize item</p>
                <h2>{selectedItem.name}</h2>
                <p className="field-hint">{selectedItem.description ?? "Choose your options before adding this item to the cart."}</p>
              </div>
              <button type="button" className="drawer-close-button" onClick={closeItemSheet}>×</button>
            </div>

            <div className="storefront-item-sheet-body">
              {getItemImage(selectedItem, selectedCategoryImage, storefront.store.heroImageUrl) ? (
                <img
                  className="storefront-item-sheet-image"
                  src={getItemImage(selectedItem, selectedCategoryImage, storefront.store.heroImageUrl)}
                  alt={selectedItem.name}
                />
              ) : null}

              <div className="storefront-option-list">
                {selectedItem.options.map((option) => (
                  <fieldset key={option.id} className="storefront-option-group">
                    <legend>{option.name}</legend>
                    <div className="storefront-choice-list">
                      {option.choices.map((choice) => (
                        <label key={choice.id} className="storefront-choice-row">
                          <input
                            type="radio"
                            name={option.id}
                            value={choice.id}
                            checked={selectedChoices[option.id] === choice.id}
                            onChange={() => setSelectedChoices((current) => ({ ...current, [option.id]: choice.id }))}
                          />
                          <span>{getChoiceLabel(choice)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ))}
                {selectedItem.addOns.length > 0 ? (
                  <fieldset className="storefront-option-group">
                    <legend>Add-ons</legend>
                    <div className="storefront-choice-list">
                      {selectedItem.addOns.map((addOn) => (
                        <label key={addOn.id} className="storefront-choice-row">
                          <input
                            type="checkbox"
                            checked={selectedAddOnIds.includes(addOn.id)}
                            onChange={() => setSelectedAddOnIds((current) => (
                              current.includes(addOn.id)
                                ? current.filter((currentId) => currentId !== addOn.id)
                                : [...current, addOn.id]
                            ))}
                          />
                          <span>{getChoiceLabel(addOn)}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                ) : null}
              </div>
            </div>

            <div className="storefront-item-sheet-footer">
              <div className="storefront-cart-quantity">
                <button type="button" className="button secondary" onClick={() => setSelectedQuantity((current) => Math.max(1, current - 1))}>
                  −
                </button>
                <span>{selectedQuantity}</span>
                <button type="button" className="button secondary" onClick={() => setSelectedQuantity((current) => current + 1)}>
                  +
                </button>
              </div>
              <button type="button" className="button primary" onClick={addSelectedItemToCart}>
                Add {selectedQuantity} · {formatCurrency((
                  selectedItem.price
                  + [
                    ...resolveSelectedOptions(selectedItem.options, selectedChoices),
                    ...resolveSelectedAddOns(selectedItem.addOns, selectedAddOnIds),
                  ].reduce((sum, selection) => sum + selection.choicePrice, 0)
                ) * selectedQuantity)}
              </button>
            </div>
          </section>
        </>
      ) : null}

      {cart.length > 0 ? (
        <button type="button" className="storefront-mobile-cart-bar" onClick={() => setCartOpen(true)}>
          <span>{cartTotals.itemCount} item{cartTotals.itemCount === 1 ? "" : "s"}</span>
          <strong>{formatCurrency(cartTotals.total)}</strong>
          <span>View cart</span>
        </button>
      ) : null}
    </section>
  );
}
