---
type: plan
status: decided
date: 2026-11-01
title: "German VAT rules for framer-clone: shipping, discounts, refunds"
summary: "Agent research, not tax advice, reviewed by Marlin on 2026-11-01 and not by a tax adviser. Germany only at launch, foreign VAT ids and addresses refused at checkout, receipt at dispatch, tax computed per rate and allocated to lines. The adviser questions are not being sent, so the tax risk is accepted."
tags: [framer-clone, commerce, vat, books]
projects: [framer-clone]
---

# German VAT rules for framer-clone: shipping, discounts, refunds

**This is research, not legal or tax advice.** It was written by an AI assistant from public sources and has not been reviewed by a Steuerberater (licensed German tax adviser). Nothing here should be filed, printed on an invoice or shipped on its authority alone. Section 10 lists what an adviser must confirm.

Date: 2026-11-01. Requested for Marlin's review before ranks 3, 5 and 6 of `docs/plans/2026-11-01-medusa-architecture-analysis.md` are built (shipping, discount codes, partial refunds). It answers section 6.3 of that plan, which left the tax question open. Scope: a German merchant selling physical goods online, regular or Kleinunternehmer (small business exempt from charging VAT under paragraph 19 of the VAT Act).

## Decisions (Marlin, 2026-11-01)

1. **Delivery: Germany only at first.** Other countries open per company once the EU rules are built.
2. **The invoice fault is closed by refusing** foreign VAT ids and foreign addresses at checkout.
3. **The receipt is issued at dispatch,** so shipping and fulfilment ship together.
4. **Rounding switches to per rate now, without waiting for an adviser,** in the same change as
   shipping and discounts.
5. **No tax adviser is asked.** The questions in section 10 stay unanswered, and the risk that one of
   the research's readings is wrong is accepted. Where section 10 leaves a choice, the research's
   recommended default applies. The limits in section 12 still stand: the official guidance was read
   in its 2024 edition.

## How to read this

Every statement carries one mark:

- **[S] sourced**: read in a primary source or in this repository's code, linked or named beside it.
- **[I] inferred**: my reasoning from sourced statements. No source says it in these words.
- **[U] uncertain**: low confidence, a secondary source only, or a point I could not reach. Do not build on it without a check.

Terms used throughout:

| Short form | Full name | What it is |
|---|---|---|
| VAT | Value added tax (Umsatzsteuer) | |
| UStG | Umsatzsteuergesetz | The German VAT Act |
| UStDV | Umsatzsteuer-Durchführungsverordnung | The ordinance implementing it |
| UStAE | Umsatzsteuer-Anwendungserlass | The tax administration's binding instructions to tax offices. Not law, but what an auditor applies |
| BMF | Bundesministerium der Finanzen | Federal Ministry of Finance, which issues letters interpreting the law |
| BFH | Bundesfinanzhof | Federal Fiscal Court |
| CJEU | Court of Justice of the European Union | |
| BGB | Bürgerliches Gesetzbuch | German Civil Code |
| AO | Abgabenordnung | German Fiscal Code |
| HGB | Handelsgesetzbuch | German Commercial Code |
| OSS | One Stop Shop | One German return for VAT owed in other EU states |
| ZM | Zusammenfassende Meldung | EC sales list, the periodic report of tax-free EU deliveries |
| BZSt | Bundeszentralamt für Steuern | Federal Central Tax Office, runs OSS and ZM |
| EN 16931 | European Norm 16931 | The EU e-invoice data standard. XRechnung and ZUGFeRD are German formats built on it |
| B2B, B2C | Business to business, business to consumer | |
| Entgelt | | The net consideration, the tax base |

**Warning on the UStAE text.** I read it on the BMF's official Umsatzsteuer-Handausgabe, 2024 edition, the newest one published there. **[S]** It has been amended since (BMF letters of December 2024, 19 December 2025 and, per a database citation, 2 June 2026). **[S/U]** One stale passage shows the risk: Abschnitt 14b.1 Abs. 2 still says ten years where the Act now says eight (question 4). So paragraph numbers and wording below may have moved. Statute text from gesetze-im-internet.de is current. **[S]**

## 1. Summary

The eight findings that change the design, most serious first.

1. **Goods to an EU business are not reverse charge.** **[S]** The code applies paragraph 13b UStG and prints its notice. For goods the correct treatment is a tax-free intra-Community supply under paragraphs 4 Nr. 1b and 6a, with a different invoice note, both VAT ids, a ZM and proof of transport. Reverse charge covers services and a short list of special domestic goods cases in paragraph 13b(2), never an ordinary parcel to an EU business.
2. **Live production fault, read from the code, not reproduced.** **[S]** An Austrian business buyer who types a VAT id pays German VAT, then `ensureReceipt` throws `TOTALS_MISMATCH` and no invoice is issued. A Swiss buyer under regular taxation pays German VAT and the receipt throws `TAX_CASE_UNSUPPORTED`. No test covers a foreign VAT id (section 4 of question 5).
3. **The order is priced before the destination is known.** **[S]** `route.ts` allows the buyer to arrive later, and `tax_region` is the constant `DE`. Tax depends on where the parcel goes, so the destination must exist before the order is priced. **[I]** The server-side checkout record (rank 2) is where it belongs.
4. **The receipt states the wrong service date once anything ships later.** **[S]** It uses the order's day. A shipped delivery happens when transport begins, and an invoice for something not yet delivered is legally an advance payment invoice that must say so **[S]** (question 4).
5. **Shipping follows the goods, split by value or weight.** **[S]** Abschnitt 14.5 Abs. 21 UStAE says so directly. This closes the point the plan marked unknown. A flat 19 percent on shipping for a mixed cart is not what the instruction describes. **[I]**
6. **A discount code and a gift card are different legal things.** **[S]** A code is a price reduction at the time of sale. A prepaid gift card is a voucher with its own tax moment. Rank 5 builds only the first; gift cards stay skipped (rank 18).
7. **Rounding per line is not the same as per rate, and the per-rate figure is what EN 16931 expects.** **[S]** The two differ by cents on ordinary carts. I recommend computing per rate and allocating to lines, so both identities hold (question 6).
8. **A refund corrects the tax in the period the money goes back** **[S]**, at the original rate. **[I]** Each refund needs its own document against the same invoice. **[I]** Today the database allows exactly one credit note per invoice and Stripe refunds are full only. **[S]**

**Recommendation that removes most of the risk now.** **[I]** Ship rank 3 with delivery to Germany only as the default, and let a company open other countries only once question 5 is built. That also closes findings 1 and 2 for new orders, except a German-delivery buyer with a foreign VAT id, which the checkout must refuse or treat as domestic. This is a product call, listed in section 11.

## 2. Question 1: shipping charges

### The law

- **Shipping charged to the customer is part of the tax base.** **[S]** EU VAT Directive [Article 78(b)][art78] includes incidental expenses such as commission, packing, transport and insurance charged by the supplier.
- **It is a secondary service that shares the fate of the main supply, even when priced separately.** **[S]** [Abschnitt 3.10 Abs. 5 UStAE][ae310] sentences 1 and 2: "Nebenleistungen teilen umsatzsteuerrechtlich das Schicksal der Hauptleistung", and this holds "wenn für die Nebenleistung ein besonderes Entgelt verlangt und entrichtet wird".
- **A mixed cart is split.** **[S]** [Abschnitt 14.5 Abs. 21 UStAE][ae145] sentences 2 and 3: costs for Nebenleistungen such as "Beförderung, Verpackung, Versicherung", charged separately, "sind sie den unterschiedlich besteuerten Hauptleistungen entsprechend zuzuordnen. Die Aufteilung ist nach geeigneten Merkmalen, z. B. nach dem Verhältnis der Werte oder Gewichte, vorzunehmen."
- **The merchant chooses among equally simple sound methods.** **[S]** [Abschnitt 10.1 Abs. 11 UStAE][ae101] sentences 2 and 3, written for a single total price over differently taxed supplies. Applying it to shipping is **[I]**.
- **Value means gross value.** **[S/U]** BFH of 22 January 2025, XI R 22/22, as [reported by Rechtslupe][bfh2222] (secondary): a single total price is split by gross individual selling prices, not net. That case concerned bundled meals, so transferring it to shipping is **[I]**, and the UStAE text I read predates it.
- **Tax-free and non-taxable supplies work the same way.** **[S]** Abschnitt 14.5 Abs. 21 sentence 1 extends the rule to those supplies. So shipping on a tax-free export or EU delivery is tax-free too. **[I]**
- **Using 19 percent for all shipping on a mixed cart overstates tax on the part belonging to 7 percent goods,** and a higher amount shown on an invoice is owed under [paragraph 14c(1) UStG][14c]. **[I]** I found no source allowing that shortcut.
- **Exemptions under paragraph 19:** a Kleinunternehmer shows no VAT, so there is nothing to allocate. **[I]**

Worked example, gross shop, integer cents. **[I]** The method is mine, the result is arithmetic:

| | 7 percent goods | 19 percent goods | Sum |
|---|---|---|---|
| Goods, gross | 20.00 | 30.00 | 50.00 |
| Shipping 4.90, by gross value 40:60 | 1.96 | 2.94 | 4.90 |
| Gross per rate | 21.96 | 32.94 | 54.90 |
| Tax extracted per rate | 1.44 | 5.26 | 6.70 |

The last cent of a split goes to the largest remainder so the parts sum exactly. **[I]** That is engineering, not law.

### What framer-clone does and must change

- **Today:** no shipping exists in orders, Books receipts or checkout. **[S]** `src/server/commerce/migrations/tenant/005_minimal_orders.ts` has no shipping column; `src/lib/commerce/cart.tsx` only mentions it in a comment.
- **Change:** one company-level split method, default gross value, recorded on the order. **[I]**
- **Change:** shipping stored as one order line per rate, with its own kind (see section 7 for the shared shape). The stored split is what refunds later read. **[I]**
- **Change:** the receipt prints shipping per rate, for example "Versandkosten (7 %)" and "Versandkosten (19 %)". **[I]**

## 3. Question 2: discounts and coupons

### The law

- **A discount at the time of sale simply lowers the tax base.** **[S]** [VAT Directive Article 79(b)][art79]. [Abschnitt 10.3 Abs. 1 UStAE][ae103]: Skonti, Rabatte and Preisnachlässe are Entgeltminderungen, the amount must be split into Entgelt and VAT, and the reason does not matter.
- **Order-level versus line-level makes no legal difference, as long as the result per rate is right.** **[I]** The invoice must show the Entgelt split by rate, [paragraph 14(4) Nr. 7 UStG][14] and Abschnitt 14.5 Abs. 18.
- **A reduction already inside the price needs no separate statement.** **[S]** Paragraph 14(4) Nr. 7 requires agreed reductions only "sofern sie nicht bereits im Entgelt berücksichtigt ist", confirmed by Abschnitt 14.5 Abs. 19 and [BMF letter of 15 October 2026][bmf2026] Rn. 15 (Randnummer, margin number). A coupon applied at checkout is known and included when the invoice is made. **[I]** So the law needs correct per-rate figures; a printed discount row is good practice and needed for reconciliation, not a separate legal field. **[I]** I am correcting the working assumption here that every discount must be printed. Only a reduction not yet reflected, such as a future bonus, needs a mention.
- **No statute fixes how a cart-wide discount is split across rates.** **[I]** The closest authority: [paragraph 17(4) UStG][17] requires a document showing how a joint change is distributed over differently taxed supplies, and Abschnitt 10.1 Abs. 8 assigns returned deposits to rates "im gleichen Verhältnis" as the original supplies, as one sound method. **[S]** Proportional allocation is the natural reading of Abschnitt 10.1 Abs. 11 too. **[I]** Confirm (adviser question 2).
- **The plan's phrase "discount before tax" only fits a net shop.** **[I]** In a gross shop the discount comes off the gross price and the tax is extracted from what remains, per Abschnitt 10.3 Abs. 1 sentence 2.

Vouchers:

- **A discount code is not a voucher.** **[S]** [Paragraph 3(13) UStG][3] sentence 2: instruments that only entitle to a price reduction "sind keine Gutscheine". [Abschnitt 3.17 Abs. 1 sentence 4 UStAE][ae317] repeats it. Tax moment: the sale. **[I]**
- **A voucher is an instrument accepted as payment.** **[S]** Paragraph 3(13).
- **Single-purpose voucher (Einzweck-Gutschein):** place of supply and VAT are fixed at issue. Selling it counts as the supply itself, so VAT is due at sale. **[S]** Paragraph 3(14), Abschnitt 3.17 Abs. 2.
- **Multi-purpose voucher (Mehrzweck-Gutschein):** everything else. Sale is outside VAT; tax arises when redeemed. **[S]** Paragraph 3(15), Abschnitt 3.17 Abs. 9.
- **The type follows from the shop's facts, not from a setting.** **[S/I]** A card redeemable against 7 and 19 percent goods is multi-purpose, Abschnitt 3.17 Abs. 9 sentence 4. A card usable only on 19 percent goods with delivery only within Germany would appear to be single-purpose. **[I]** Same for a shop later adding a second country. Abschnitt 3.17 Abs. 9 sentence 6 asks the issuer to label a multi-purpose voucher visibly.
- **On the invoice, a redeemed voucher is a payment, not a discount.** **[I]** A multi-purpose card pays part of the gross amount, tax stays on the full price. A single-purpose redemption is no new taxable supply, because the supply counted at issue, paragraph 3(14). **[S]**

Worked example, same cart with a 10.00 gross code on goods only. **[I]**

| | 7 percent | 19 percent | Sum |
|---|---|---|---|
| Goods after 40:60 discount split | 16.00 | 24.00 | 40.00 |
| Shipping 40:60 | 1.96 | 2.94 | 4.90 |
| Gross per rate | 17.96 | 26.94 | 44.90 |
| Tax per rate | 1.17 | 4.30 | 5.47 |
| Net per rate | 16.79 | 22.64 | 39.43 |

### What framer-clone does and must change

- **Today, orders:** no discount columns. **[S]** `005_minimal_orders`.
- **Today, Books:** only a per-line percentage in basis points (`discount_bp`, `src/server/books/totals.ts`, 0 to 10000 by CHECK), which cannot express an exact cent amount. **[S]** A whole-invoice discount is open as roadmap item 8c. **[S]**
- **Today, negative lines:** `subtotal >= 0` on `order_line_item`, and on Books lines negative amounts exist only as copies of imported printed discounts (migration 009). **[S]** Do not relax these. **[I]** Fold discounts into each line instead.
- **Change:** an exact-cents line discount on Books lines, in place of or beside `discount_bp`, so a receipt line can carry the allocated amount. This also serves roadmap 8c and maps to a line allowance in EN 16931. **[I]**
- **Change:** an order discount snapshot (code, amount, per-line allocation) in new rows; the order row stays immutable. **[I]**
- **Change:** the receipt prints a discount row per line or a summary row that reconciles to the per-rate totals, and the completeness check in `render/completeness.ts` verifies it. **[I]**

## 4. Question 3: refunds, partial refunds and returns

### The law

- **Paragraph 17(1) UStG corrects tax when the base changes.** **[S]** [Paragraph 17][17]: supplier corrects the tax, recipient corrects input tax, in the tax period of the change. Directive [Article 90][art90].
- **A reversed supply is treated the same.** **[S]** Paragraph 17(2) Nr. 3. [Abschnitt 17.1 Abs. 8 UStAE][ae171]: reversal exists when the deal is undone, the expectation of payment falls away and the buyer returns the goods in unwinding it. [Abschnitt 1.1 Abs. 4][ae11]: a Rückgabe is no supply. A statutory withdrawal fits that description. **[I]** I found no passage naming paragraph 355 BGB withdrawal in these words.
- **The period is the one in which the money actually goes back.** **[S]** Abschnitt 17.1 Abs. 2 sentence 3 (BFH V R 56/06): the base falls "nur, soweit das Entgelt tatsächlich zurückgezahlt wird, und zwar in dem Besteuerungszeitraum, in dem die Rückgewähr erfolgt".
- **The statute does not require a document for a single refund.** **[S]** Abschnitt 17.1 Abs. 3 sentences 3 and 4: the duty to correct does not depend on changing the original invoice, and "Ein Belegaustausch ist nur für die in § 17 Abs. 4 UStG bezeichneten Fälle vorgeschrieben."
- **An invoice left standing after a negotiated price cut is not a paragraph 14c problem.** **[S]** [Abschnitt 14c.1 Abs. 4 sentences 2 and 3 UStAE][ae14c1]: the consequences of paragraph 14c(1) do not arise where the price is validly lowered by later agreement.
- **A full reversal may differ.** **[U]** A statutory withdrawal is a reversal under paragraph 17(2) Nr. 3, not an agreement, and the invoice then documents a supply that no longer stands. Whether that leaves exposure under paragraph 14c(2) was not answered by anything I read, and it is a good reason to always issue a Stornorechnung. Adviser question 5.
- **So issue a document every time.** **[I]** Reasons: the open point above, a B2B buyer must correct input tax, a booking needs a voucher, Books must reconcile with the money, and mixed-rate refunds need a per-rate split in the spirit of paragraph 17(4). This is a practice recommendation, not a statutory duty.
- **What a correction document needs.** **[S]** [Paragraph 31(5) UStDV][31] and [Abschnitt 14.11 Abs. 1 UStAE][ae1411]: specifically and unambiguously tied to the invoice, normally by its number; no new invoice number is required for it; it must meet the formal rules of paragraphs 14 and 14a.
- **Naming.** **[S]** In tax law a "Gutschrift" is a self-billing document issued by the recipient, paragraph 14(2) and 14(4) Nr. 10. [Abschnitt 14.3 Abs. 1 sentence 5][ae143]: a Stornierung or correction commonly called Gutschrift is not one. Abschnitt 14c.1 Abs. 3 sentence 4: the label alone does not trigger paragraph 14c. So `'Gutschrift (Stornorechnung)'` in `src/server/books/template/labels.ts` is harmless but imprecise. **[I]** "Rechnungskorrektur" or "Stornorechnung" is cleaner.
- **E-invoices.** **[S]** [BMF 15 October 2026][bmf2026] Rn. 20 and 21: where an e-invoice was required, the correction must also be one, and any practical form works as long as original plus correction read together are unambiguous.

Consumer law that decides the amount, not VAT:

- **Withdrawal refund covers outbound delivery.** **[S]** [Paragraph 357(2) BGB][357]: the merchant returns delivery payments too, except the extra cost of anything above the cheapest standard delivery offered.
- **Return shipping is the consumer's only if properly informed.** **[S]** Paragraph 357(5).
- **14 days, same payment method, may wait for the goods or proof of dispatch.** **[S]** Paragraph 357(1), (3), (4).
- **Partial withdrawal, keeping some items:** whether outbound shipping is owed at all is not answered by paragraph 357. **[U]** Civil law question for the adviser or a lawyer.
- **Lost value (Wertersatz, [paragraph 357a BGB][357a]):** VAT treatment of a deduction is open. **[U]** Abschnitt 1.3 treats genuine damages as outside VAT, but I found nothing on this case.
- **Withdrawal function.** **[S]** [Paragraph 356a BGB][356a] requires a permanently available online withdrawal function labelled "Vertrag widerrufen" or similar. This is not VAT, but the returns spec (rank 7) must cover it. **[I]** I did not check whether a storefront already offers it, and I did not verify its effective date. **[U]**

Return shipping tax:

- **Buyer pays the carrier:** no effect on the merchant's VAT. **[I]**
- **Merchant pays a return label:** a merchant cost with input tax on the carrier's invoice; the sale is not reduced beyond the refund. **[I]**
- **Merchant deducts return cost from the refund:** open whether that is a smaller refund or a separate charge. **[U]** Adviser question 5.

### What framer-clone does and must change

- **Full cancellation exists; partial does not.** **[S]** `src/server/books/cancel.ts` header: "partial credit notes are deferred". Lines and totals are copied unchanged, which is correct for a full reversal. **[I]**
- **One credit note per invoice is enforced.** **[S]** Unique index `sales_document_one_credit_note_key` in `007_books.ts`. Must become scoped to full cancellations, with partial documents allowed alongside. **[I]**
- **Cumulative guard needed:** credited quantity and amount per invoice line must never exceed the original. **[I]**
- **The reference line says "Storno der Rechnung".** **[S]** `labels.ts`, checked by `render/completeness.ts`. A partial correction needs other wording, such as "Korrektur zu Rechnung X vom Y". **[I]**
- **Stripe refunds are always full.** **[S]** `src/server/commerce/payment/stripe/connect.ts`: `refund` ignores the `amount` argument, and `client.ts` sends only `payment_intent` and `refund_application_fee`. `order_payment.refund_id` holds one id. Plan rank 6 already calls for refund rows.
- **The late refund path is sound for tax.** **[I]** `refundLatePayment` refunds before any receipt exists, so there is nothing to correct.
- **`paid>refunded` is allowed by the database with no code path.** **[S]** `021_order_payment.ts`, `payments.ts`. When it gets one, it must issue the Books cancellation in the same flow. **[I]**
- **A second legacy `credit_note` table exists** from migration 004, with a foreign key to order. **[S]** Books uses `sales_document`. Pick one; the rank 6 spec should remove the unused one. **[I]**
- **Rate and split come from the stored snapshot, never recomputed.** **[I]** A correction undoes tax at the original rate. Note `correct.ts` recomputes "under the tax profile as it stands today" for the replacement draft, which is right for that flow and wrong for a refund. **[S/I]**

## 5. Question 4: invoice contents, e-invoices, retention

### The law

- **Full invoice.** **[S]** [Paragraph 14(4) UStG][14]: names and addresses of both parties, seller's tax number or VAT id, issue date, unique sequential number, quantity and trade description, date of supply (or of payment for an advance), Entgelt by rate and exemption plus reductions not yet included, rate and tax amount or a note on the exemption.
- **Intra-Community supply and reverse charge extras.** **[S]** [Paragraph 14a UStG][14a]: paragraph (3) both VAT ids and an invoice by the 15th of the following month for intra-Community supplies; (1) and (5) the words "Steuerschuldnerschaft des Leistungsempfängers" for reverse charge.
- **Exemption note.** **[S]** Abschnitt 14.5 Abs. 20 sentences 4 to 6: the statute need not be named, but the reason should appear, in plain words such as "Ausfuhr" or "innergemeinschaftliche Lieferung".
- **Small invoice up to 250 euro gross.** **[S]** [Paragraph 33 UStDV][33]: seller's name and address, issue date, quantity and description, gross sum, rate or exemption note. It does not apply to supplies under paragraphs 3c, 6a and 13b. It may always go as a non-e-invoice.
- **Kleinunternehmer invoice.** **[S]** [Paragraph 34a UStDV][34a]: names and addresses, tax number or VAT id or small-business id, issue date, quantity and description, total payable with a note that the exemption applies. It may always go as a non-e-invoice.
- **Duty to issue.** **[S]** Paragraph 14(2): required towards businesses within six months. Paragraph 14a(2): required for a distance sale taxed in Germany unless the seller uses OSS. Towards German consumers there is no general duty for ordinary goods. **[I]** A voluntary invoice must still be correct. **[I]**
- **Date of delivery.** **[S]** [Paragraph 3(6) UStG][3]: a shipped supply counts as made where transport begins. [Abschnitt 13.1 Abs. 2 sentence 2 UStAE][ae131]: such supplies are made "im Zeitpunkt des Beginns der Beförderung oder Versendung". [Abschnitt 14.5 Abs. 16][ae145] requires the date even if equal to the issue date; [paragraph 31(4) UStDV][31] allows the calendar month.
- **Invoicing before delivery is an advance payment invoice.** **[S]** Abschnitt 14.5 Abs. 16, "Noch nicht ausgeführte Lieferung": it is "eine Rechnung über eine Anzahlung", the payment date is needed only if known and different from the issue date, and the invoice must make clear that the supply has not happened yet.
- **Tax on a prepaid order arises in the month of payment.** **[S]** [Paragraph 13(1) Nr. 1a sentence 4 UStG][13].

E-invoice timeline. **[S]** [Paragraph 14 UStG][14], [paragraph 27(38) UStG][27], [BMF 15 October 2026][bmf2026]:

| From | Rule |
|---|---|
| 1 January 2025 | Every German business must be able to receive e-invoices |
| Until 31 December 2026 | Paper or any electronic format allowed for domestic B2B supplies of 2025 and 2026 |
| 1 January 2027 | Only businesses with prior-year total turnover up to 800,000 euro may still use other formats, for 2027 supplies |
| 1 January 2028 | Every domestic B2B invoice is an e-invoice |

- **Outside the duty:** consumers, foreign customers, invoices up to 250 euro, and Kleinunternehmer as issuers. **[S]** Paragraphs 33 and 34a UStDV for the last two; the domestic scope from BMF and the second letter's summaries. **[S/U]** I read the third letter in full, the 2024 and 2025 letters only through summaries.
- **The third BMF letter bears directly on this shop.** **[S]** [15 October 2026][bmf2026], reference III C 5 - S 7287-a/00019/021/017, Rn. 18 and 19: EN 16931 calculates from the net amount, so gross-based pricing can produce rounding differences, no gross format exists yet for XRechnung and ZUGFeRD, and until 31 December 2027 a gross-based e-invoice may show only per-rate totals in the structured part, with the itemised lines in an embedded readable annex. Default `price_basis` for new products is gross. **[S]** `020_catalogue_company.ts`.
- **An unknown business buyer is protected.** **[S]** Same letter, Rn. 5: no objection while the seller neither knew nor could have recognised with due care that the buyer was a business.
- **A business-rule error is not automatically fatal for tax.** **[S]** Rn. 22 and 23.
- **EU cross-border e-invoices:** an EU rule set planned for 2030 (VAT in the Digital Age). **[U]** Mentioned by [Haufe][haufe2026] as further reporting from 1 July 2030; not read at source.

Retention:

- **Invoices: eight years** from the end of the issue year. **[S]** [Paragraph 14b(1) UStG][14b].
- **Booking vouchers: eight years; books and records: ten.** **[S]** [Paragraph 147(3) AO][147], [paragraph 257(4) HGB][257].
- **Records for OSS sales: ten years.** **[S]** [Paragraph 22 UStG][22], [BZSt][bzst].
- **The period does not end while the documents matter for an open assessment.** **[S]** Paragraph 147(3) AO, last sentence.
- **The transition rule for documents from before 2025** was not read. **[U]**

### What framer-clone does and must change

- **Completeness as code matches paragraphs 14 and 34a for the domestic case.** **[S]** `render/completeness.ts`, and its header describes both. Good.
- **The receipt's service date is wrong for anything not delivered that day.** **[S/I]** `receipt.ts` sets `serviceDate: berlinDay(order.created_at)`, and it issues on payment, before any shipment. Today that is defensible only for same-day handover. Shipping makes it wrong by default.
- **Choice for the shipping spec:** (a) issue the receipt at dispatch, with the dispatch date as service date. Cleanest. The order confirmation carries the payment until then; (b) issue on payment, naming the calendar month of expected delivery under paragraph 31(4) UStDV; (c) issue on payment as an advance invoice, then a final invoice. Recommended: (a). **[I]** It needs rank 4 (fulfilment) to exist, because a dispatch event is the trigger. The tax period still follows the payment date in every option. **[S]**
- **A retail buyer who wants a document at once:** order confirmation mail plus the invoice after dispatch. **[I]** Pure B2C shops may not need an invoice at all, but the platform should not vary by shop. **[I]**
- **Goods to EU business:** `completeness.ts` must require both VAT ids and the "innergemeinschaftliche Lieferung" note for that treatment. **[I]**
- **Notice text.** **[S]** `REVERSE_CHARGE_NOTICE` prints "Leistungsempfaengers" and "Section 13b", and `KLEINUNTERNEHMER_NOTICE` differs from `DEFAULT_EXEMPTION_NOTE` in `settings.ts`. Paragraph 14a demands the exact words with the umlaut. **[I]** Use "Steuerschuldnerschaft des Leistungsempfängers" and one small-business wording. Whether the ASCII form is a formal defect is unknown. **[U]** The repository's no-long-dashes rule does not require avoiding umlauts. **[I]**
- **E-invoicing plan (roadmap item 9):** add the gross-pricing problem, and write it in time for 1 January 2027 if any shop can exceed 800,000 euro. **[I]** The plan date of first half 2027 is too late for those, though for a first-generation shop that is unlikely. **[I]**
- **Retention.** **[S]** `src/server/books/render/format.ts` comment says "ten years", and issued documents are append-only. Keep ten years as the simple uniform rule because OSS records need it and it exceeds the invoice rule. **[I]** A later deletion job for personal data then needs a date. **[I]** Add it to the plan as a data protection item, not here.

## 6. Question 5: EU sales, One Stop Shop, business customers, third countries

### The law, German regular-tax seller shipping from Germany

| Buyer and destination | Treatment | Source |
|---|---|---|
| Anyone, Germany | German rate | **[S]** |
| Consumer, other EU state, EU-wide B2C sales up to 10,000 euro net in the prior and current year | German rate, German return | **[S]** [Paragraph 3c(4)][3c], [Abschnitt 3c.1 examples][ae3c] |
| Consumer, other EU state, threshold exceeded or waived | Destination state's rate, via OSS or local registration | **[S]** Paragraph 3c(1), [paragraph 18j][18j], [BZSt][bzst] |
| Business with valid VAT id of another member state | Tax free, with conditions below | **[S]** [Paragraph 4 Nr. 1b][4], [6a][6a] |
| Business without a valid id | Not an intra-Community supply; German VAT at least | **[S/I]** Paragraph 6a(1) Nr. 4; smaller non-taxable businesses count as acquirers under paragraph 3c, Abschnitt 3c.1 |
| Outside the EU | Tax free export, with proof | **[S]** Paragraph 4 Nr. 1a, [paragraph 6][6], [paragraph 10 UStDV][10] |

Details:

- **Threshold.** **[S]** One EU-wide figure, for sales in total, not per country. Waiving binds for two calendar years. [BZSt][bzst] also says net of VAT. It counts all cross-border B2C sales of the business, including those outside framer-clone. **[I]** Whether the crossing sale itself is already foreign is **[U]**. The Act says the amount must not be exceeded in the current year, which suggests yes. **[I]**
- **OSS mechanics.** **[S]** [BZSt][bzst]: quarterly online returns due at the end of the following month, nil returns too, no direct debit, ten-year records, registration effective from the next quarter, or by the 10th of the following month after a first supply over the threshold, never later.
- **Invoices under OSS.** **[I]** [Paragraph 14a(2)][14a] speaks of a paragraph 3c supply in Germany and lifts that duty for OSS users. For outbound sales, my reading is that OSS sellers follow German invoice rules and non-OSS sellers the destination state's (VAT Directive Article 219a, from memory, not read). **[U]** A foreign consumer can get an invoice in any case.
- **Rates are the destination's,** for that product, and classifications differ. **[I]** A German 7 percent book or food item is not automatically reduced elsewhere.
- **Intra-Community conditions.** **[S]** Paragraph 6a(1): goods go to another member state, buyer is a business registered there for VAT, acquisition taxable there, buyer used a valid id issued by another state. Paragraph 6a(3): the seller must prove this. Paragraph 4 Nr. 1b: the exemption falls away if the ZM is missing or wrong.
- **ZM.** **[S]** [Paragraph 18a UStG][18a]: by the 25th after each month with such supplies (a quarterly option exists under a turnover limit).
- **Proof of transport.** **[S]** [Paragraphs 17a and 17b UStDV][17a]: a presumption from independent carrier documents, or a Gelangensbestätigung (buyer's confirmation of arrival).
- **Validity check.** **[S]** [Paragraph 18e UStG][18e]: the BZSt confirms an id and the holder's name and address. Paragraph 6a(4) protects a seller misled despite commercial care. Storing the check's result is the evidence. **[I]**
- **Reverse charge does not cover this.** **[S]** [Paragraph 13b(2)][13b] lists services and specific domestic goods cases (for example gold, goods in its Anlage 3, and mobile phones, tablets and game consoles above an order value), and 13b(5) makes the recipient liable in those cases. An ordinary sale of goods from Germany to an EU business is not on it. A general shop should flag those listed goods sold to German businesses, and never route EU parcels through them. **[I]** Paragraph 14a(1) reverse charge wording concerns supplies taxed abroad with the recipient liable; for goods the seller uses 14a(3). **[I]**
- **Third countries.** **[S]** Paragraph 10 UStDV: electronic export declaration with exit note, or other shipping documents. Postal and small parcel practice was not read. **[U]** The buyer normally pays import tax locally. **[I]**
- **Northern Ireland.** **[S/U]** Goods treated as within the EU, "XI" VAT ids count as issued by another member state, per [IWW on paragraph 30 UStG][xi] and the BMF letter of 10 December 2020. Secondary reading only.
- **Places in an EU country that are outside the VAT area** (Canary Islands, Heligoland, Åland and others). **[U]** Not read in this research. A country code alone does not capture them. **[I]**
- **Greek VAT ids use EL, the country code is GR.** **[U]** From memory, not sourced here.

Kleinunternehmer:

- **Thresholds:** 25,000 euro prior year, 100,000 current year. **[S]** [Paragraph 19(1) UStG][19].
- **The supply is tax free.** **[S]** The rest of paragraph 19(1) excludes paragraphs 4 Nr. 1b and 6a, and the VAT ids on invoices. So an EU delivery to a business is simply a paragraph 19 sale. No intra-Community supply exists, so nothing goes on a ZM for it. **[I]** Paragraph 19 keeps paragraph 18(4a) in force, which I did not read. **[U]**
- **Above 10,000 euro in other EU states, the place of supply moves abroad,** and paragraph 19 covers only German sales. **[I]** That leaves two routes. **Route one:** charge destination VAT, and OSS is open to Kleinunternehmer. **[S]** [Abschnitt 18j.1 Abs. 1 sentence 2][ae18j]. **Route two:** [paragraph 19a UStG][19a], a special reporting procedure to use another state's small-business exemption, with a Kleinunternehmer-Identifikationsnummer from the BZSt, EU-wide turnover up to 100,000 euro, and that state's own conditions. **[S]** Its details for each state were not read. **[U]**
- **Code link.** **[S]** The Books sender field `smallBusinessId` and the small-business id in paragraph 34a UStDV belong to this procedure. **[I]** The field exists; no logic uses it to decide a destination.
- **Crossing 100,000 euro in the year** ends the exemption, and the exact moment and the Abschnitt 19.1 text were not read. **[U]** Secondary source [Juraforum][juraforum] says it applies to the crossing sale.
- **A Kleinunternehmer who prints VAT owes it.** **[S]** Paragraph 14c(2).

### What framer-clone does and must change

- **`resolveTaxProfile` covers only three outcomes:** small business, reverse charge, German rates. **[S]** `germanVat.ts`. An EU consumer always gets German VAT, with no threshold or OSS logic, and a third-country recipient under regular taxation is refused at issue. It does not distinguish goods and services.
- **Order and receipt follow different logic.** **[S]** `src/app/api/commerce/orders/route.ts` sets neither `customerType` nor `vatId` nor `reverseCharge`, so every order is `b2c` with `tax_region` DE. `receipt.ts` `customerFor` sets `b2b` when the buyer typed an id, with `buyer.country`.

| Buyer | Paid at checkout | What Books does | Result |
|---|---|---|---|
| AT business with VAT id, regular seller | German VAT | Resolves reverse charge, line tax 0 | `TOTALS_MISMATCH`, draft deleted, no invoice **[S]** |
| CH buyer, regular seller | German VAT | Profile unsupported | `TAX_CASE_UNSUPPORTED`, no invoice **[S]** |
| EU consumer above threshold | German VAT | Same | Receipt issued with the wrong country's tax **[S/I]** |
| GB buyer in Northern Ireland | German VAT | Treated as third country | No invoice **[S/I]** |

- **Coverage.** **[S]** The only business buyer test uses a German id (`src/server/commerce/payment/__tests__/payments.itest.ts:233`). Read from the code; I did not run this path.
- **`payments.ts` keeps the error on the payment; the money stays taken.** **[S]** Plan section 5.5 notes there is no order list to show it.
- **Billing is used, not delivery.** **[S]** Tax follows where the transport ends, paragraph 3c(1) and 6a(1). **[S]** `buyer.ts` has a single address. A separate delivery address is required before any cross-border logic. **[I]**
- **Tax must wait for the address.** **[S]** `orderBodySchema` makes `buyer` optional. **[I]** The checkout record must hold destination and VAT id status before pricing.
- **Treatments needed in the `TaxTreatment` enum:** `intra_community_exempt`, `export_exempt`, and a marker for destination rates. **[I]** Existing `reverse_charge` stays for services, `kleinunternehmer` stays.
- **A rate table by country and class** replaces the two constants for OSS sellers. **[I]** Rank 12.
- **Reverse-charge path in `resolveTaxProfile` must branch on line kind.** **[I]** A mixed Books invoice needs both notes and two buckets.
- **VAT id validation:** the code comment says out of scope. **[S]** It becomes required for tax-free treatment. **[I]** Automated check at checkout through the BZSt, stored with the order. The interface was not checked. **[U]**
- **Evidence store:** carrier reference per shipment, ZM export per period. **[I]** Rank 4 and rank 12.
- **Threshold:** framer-clone cannot see all of a company's sales, so it must be a company declaration ("OSS registered") plus a warning from what it can count. **[I]**

## 7. Question 6: rounding

### The law

- **The tax must be exact to the cent, rounded commercially.** **[S]** [Abschnitt 14.5 Abs. 20 sentences 2 and 3 UStAE][ae145]: down when the next digit is at most 4, otherwise up. Repeated in [BMF 15 October 2026][bmf2026] Rn. 17. `Math.round` on non-negative values does this. **[I]** Credit amounts are stored positive, so that stays safe. **[S]** `cancel.ts`.
- **Neither the UStG nor the UStDV says at which level to round.** **[I]** I found no such rule. Paragraph 14(4) Nr. 8 speaks of the tax on the Entgelt. [Paragraph 32 UStDV][32] allows one tax sum for machine-made mixed-rate invoices if each item states its rate.
- **EU law leaves rounding to member states within neutrality and proportionality, and need not allow per-item rounding down.** **[S/U]** CJEU C-484/06 Koninklijke Ahold, 10 July 2008, per [VATupdate][ahold] and [Haufe][haufe-round]. I could not open the judgment.
- **EN 16931 calculates per VAT category.** **[S]** The [official validation rules][en16931] for the European standard: BR-CO-17 and BR-S-09 say category tax equals category taxable amount times rate, rounded to two decimals. BR-CO-14 says total VAT is the sum of the category amounts. BR-CO-10 says line net amounts sum to the invoice net amount. BR-CO-15 says gross is net plus VAT.
- **An EN 16931 line has no tax amount at all.** **[S]** The validation rules warn that a UBL invoice should not include an invoice-line tax total (UBL-CR-561). A line carries its net amount, category and rate (BT-151, BT-152); tax amounts sit in the per-category breakdown. So a per-line tax is simply not transferable into an e-invoice. This is the strongest argument for per-rate. **[I]** Separate categories exist for reverse charge, intra-Community supply and export (rules BR-AE, BR-IC, BR-G), which matches the treatments question 5 needs. **[S]**
- **There is a tolerance in the checks.** **[S]** The BR-CO-17 and BR-S-09 tests accept a difference of under 1 whole currency unit, not one cent. So per-line sums usually pass today. Whether the rules of KoSIT (Koordinierungsstelle für IT-Standards, which publishes XRechnung and its validator) are stricter was not checked. **[U]** Rn. 18 of the BMF letter treats rounding differences as a real issue, so do not rely on the tolerance.

How far apart the two are. **[I]** Computed in integer cents:

| Case | Per line | Per rate |
|---|---|---|
| 3 lines 1.33 net at 19 percent | 0.75 | 0.76 |
| 3 lines 1.99 gross at 19 percent | 0.96 | 0.95 |
| 40 lines 0.03 net at 19 percent | 0.40 | 0.23 |

### What framer-clone does

- **Per line everywhere, one implementation.** **[S]** `computeLineTax`, used by `createOrder.ts` and `totals.ts`. Both sum line taxes, and the identities hold: `order_total_sum_check` for `total = subtotal + tax_amount`, trigger BK005 for totals against lines.
- **The receipt only compares totals.** **[S]** `receipt.ts`: `view.document.total !== order.total`. Two differing splits with the same total pass unnoticed. **[I]**
- **The receipt re-derives from `tax_class`, not the snapshot rate.** **[S]** So a rate change between order and receipt, or a `taxRate` override, would give a mismatch. **[I]**

### Recommendation: per-rate canonical, allocated to lines

1. **One pure function prices a document:** inputs are lines, line discounts, cart discount, shipping, profile; outputs are lines and rate buckets. **[I]** It lives beside `computeLineTax` so "one semantic, one implementation" survives, and the order and Books both call it. **[S]** That rule is in the header of `germanVat.ts`.
2. **Bucket first.** **[I]** Net shop: bucket net, then tax = round(net × rate). Gross shop: bucket gross, then tax = round(gross × rate / (1 + rate)), net = gross minus tax. This is what the customer can recompute from the printed totals.
3. **Then allocate the bucket's tax to its lines by largest remainder.** **[I]** Line tax still sums to the document tax, so BK005 and `order_total_sum_check` keep their meaning and need no change. Refunds read these line amounts, so a full return of all lines gives exactly the original tax.
4. **Printed totals remain per rate,** as `modelTotals` already does. **[S]**
5. **Issued documents are frozen, so the new calculation applies only to new ones.** **[I]** No rewrite of history. `tax_summary` stays the source for a reprint. **[S]**

Why not keep per line: it is probably lawful **[U]**, and the tolerance accepts it today **[S]**, but it can fail a customer's own recalculation, and BMF Rn. 18 signals the issue. Changing after e-invoicing would mean changing a live money path. **[I]** Why it is reasonable now: shipping and discounts rewrite this code anyway. **[I]**

What Books and the order must agree on, per order:

| Item | Rule |
|---|---|
| Gross total | Equal to the cent, equal to the payment amount **[S]** today, keep |
| Net and tax per (rate, treatment) bucket | Equal, compared at receipt time **[I]** |
| Rate on each line | Copied from the order snapshot, never re-derived **[I]** |
| Shipping lines and discount amounts | Copied **[I]** |
| Tax profile | Decided once, at checkout, and passed to Books **[I]** |
| Rounding rule | One function **[I]** |

## 8. Rules for the three specs

Shipping spec (rank 3):

1. Shipping takes the rate of the goods, split across rates; never a fixed 19 percent. **[S]**
2. Default split: gross value of shipped lines after discounts; company-level, stored on the order. **[I]**
3. Only physically shipped lines take part. **[I]**
4. One order line per rate, sum exact by largest remainder. **[I]**
5. Same applies to packing, insurance and cash-on-delivery fees charged separately. **[S]** Abschnitt 14.5 Abs. 21 names the first two; the third is **[I]**.
6. Exempt goods give exempt shipping. **[S/I]**
7. Snapshot the cheapest standard delivery price at purchase, because a withdrawal refund depends on it. **[I]**
8. Destination is known before pricing; a separate delivery address exists. **[S/I]**
9. Default delivery country Germany only, until question 5 is built. **[I]**
10. Receipt issued at dispatch, with the dispatch date. **[I]** Depends on rank 4.

Discount spec (rank 5):

1. Discount codes are price reductions, never vouchers. Do not sell, store or transfer value. **[S]**
2. A prepaid or transferable balance is out of scope and stays rank 18. **[S/I]** If built, type follows from the rate set and delivery countries at issue.
3. Result per rate must be right; a cart discount is split proportionally by gross line value. **[I]**
4. Gross shop: comes off gross. Net shop: comes off net. **[I]**
5. Discount fits in each line, exact cents, no negative lines. **[S/I]**
6. Applied order: line discounts, then cart discount, then shipping allocation, then tax. **[I]**
7. A discount on shipping (free shipping code) lowers shipping per rate in the same way. **[I]**
8. Order snapshot stores code, amount and per-line result, so refunds need no recalculation. **[I]**
9. Document shows per-rate figures after discount and a reconciling discount row. **[S/I]**
10. Works unchanged for Kleinunternehmer, with one gross figure. **[I]**

Refund spec (ranks 6 and 7):

1. Each refund is a row, linked to a Books correction document naming the invoice number and date. **[S/I]**
2. Original rate and allocation from the snapshot, never today's rules. **[I]**
3. Per-rate split shown on every document. **[I]**
4. Store the actual refund date. Tax reports use it, not the document date. **[S]**
5. Several partial documents per invoice, capped per line. **[I]**
6. Full withdrawal: goods plus outbound shipping up to the cheapest standard price. **[S]**
7. Return shipping costs do not touch VAT unless deducted from the refund. **[I/U]**
8. Goodwill refunds without a line: split by original per-rate proportion. **[I]**
9. Refund before an invoice exists: no document needed. **[I]**
10. Kleinunternehmer: same documents, no VAT figures, exemption note repeated. **[I]**
11. Where the invoice was an e-invoice, the correction is too. **[S]**
12. Stock return and tax correction are separate events; money can go first, per paragraph 357(4) BGB. **[I]**
13. No "Storno" wording on a partial; use "Korrektur". **[I]**

## 9. Small corrections to repository documents

- **Plan section 6.3 "shipping tax follows the items" is confirmed.** **[S]** Change [unknown] to the UStAE reference.
- **`docs/plans/2026-10-21-books-visual-template-composer.md` section 14:** add the 15 October 2026 letter and the gross-price rule. **[I]**
- **`render/format.ts` "ten years":** eight is the invoice figure, ten the deliberate platform choice. **[I]**
- **Roadmap item 8c** (whole invoice discount): shares this engine, so plan it with rank 5. **[I]**

I changed no repository file.

## 10. Questions for a Steuerberater

Ordered by how much of the build depends on them.

1. **Shipping split.** Is gross value of shipped lines after discount accepted as the split under Abschnitt 14.5 Abs. 21 UStAE, for both gross and net shops, given BFH XI R 22/22 was about bundles? Is largest remainder acceptable for the last cent?
2. **Cart discount.** Is proportional allocation by gross line value across 7 and 19 percent correct, or may a code apply to one rate's goods only if the terms say so?
3. **Rounding.** Is per-rate calculation with allocation of tax to lines acceptable for a shop and for Books? Is per-line rounding, the current method, acceptable for documents already issued? Do any printed line taxes need to exist?
4. **Receipt timing.** For a prepaid online order, is an invoice at dispatch with that date fine, with the VAT period following payment? Is the calendar month option safe if delivery slips into the next month? Do existing paid and shipped orders with an order-day service date need a correction?
5. **Withdrawal amounts.** How is a deduction treated in VAT for (a) return shipping the merchant fronted, and (b) Wertersatz under paragraph 357a BGB? On which date is the correction due if goods return in October and money in November? After a full withdrawal, does the invoice left without a Stornorechnung create exposure under paragraph 14c(2), given that Abschnitt 14c.1 Abs. 4 only speaks of an agreed reduction?
6. **Partial withdrawal.** Is outbound shipping refundable when only some items are withdrawn, and how does this split across rates? (May need a civil lawyer.)
7. **Intra-Community goods.** Is the plan workable for parcels to EU businesses: VAT id checked at checkout through the BZSt, carrier tracking as proof, ZM export? What exactly suffices for parcels under paragraphs 17a and 17b UStDV? Treatment if a business gives an invalid id: German VAT at checkout, then correct if a valid id arrives later?
8. **Threshold crossing.** Under paragraph 3c(4), is the sale that crosses 10,000 euro already taxed abroad? Same question for 100,000 euro under paragraph 19(1).
9. **Kleinunternehmer selling to the EU.** After passing 10,000 euro, which route fits: destination VAT through OSS, or the paragraph 19a procedure in each destination state? Can the two be combined by state? What must the invoice show in each route? Does the seller lose paragraph 19 only for those sales?
10. **Gift cards, if ever built.** Confirm a card for a German shop with mixed rates is multi-purpose, and whether a single-rate Germany-only shop's card is single-purpose. How must discount codes differ in terms so they stay non-vouchers?
11. **Gross e-invoices.** After 31 December 2027, how should a gross-priced shop produce domestic B2B e-invoices? Is per-rate gross extraction with net allocation to lines compliant with Rn. 17 to 19?
12. **Notices.** Does `Leistungsempfaengers` (ASCII form) on issued invoices need correcting? For a Kleinunternehmer, is "wird keine Umsatzsteuer ausgewiesen" a sufficient note under paragraph 34a?
13. **Exports.** What proof suffices for low-value parcels to Switzerland and the United Kingdom? Which regions need a block (Heligoland, Canary Islands, Northern Ireland handling)?
14. **Retention.** Is ten years uniform acceptable against data protection minimisation for buyer addresses, or must personal data go at eight?

## 11. Decisions for Marlin

Product calls, not tax questions. My recommendation in each case.

1. **Delivery countries at launch.** Recommended: Germany only by default, opening others per company after question 5 is built. Cost: no sales abroad from day one, including Austria.
2. **Receipt at dispatch or payment.** Recommended: dispatch. Cost: buyers wait for an invoice, and ranks 3 and 4 must ship together.
3. **Switch rounding to per rate now.** Recommended: yes, in the same change as shipping and discounts, after adviser question 3.
4. **Pricing abroad, when opened.** Same gross everywhere (margin varies) or same net (price varies by country). Reasonable people choose differently.
5. **Live fault in the meantime.** I recommend a small immediate fix independent of all this: refuse a foreign VAT id or foreign address at checkout for regular-taxed companies, or issue a human alert. That needs its own small plan and a roadmap line. Not done here.

## 12. What I could not verify

- **The current UStAE.** I read the 2024 Handausgabe. Amendments of December 2024, December 2025 and possibly June 2026 are unread, including the Kleinunternehmer changes in Abschnitt 19.1. **[S]**
- **BMF letters of 15 October 2024 and 15 October 2025:** only summaries. The third, of 15 October 2026, I read in full. **[S]**
- **EUR-Lex and the CJEU site** refused automated access. Directive articles come from the retained copy on legislation.gov.uk, whose Article 78 is the same text. **[S]** Ahold comes from secondary sources. **[U]**
- **BFH XI R 22/22:** secondary report only. **[U]**
- **XRechnung rules from KoSIT:** I read the European EN 16931 rules, main branch, for UBL, not the German add-on rules. **[U]**
- **No code was run.** All code statements come from reading, including the `TOTALS_MISMATCH` path. **[S]**
- **Not researched:** storefront withdrawal button, VAT id checking interface, special VAT territories, margin taxation (second-hand goods), consignment stock abroad, marketplace rules, Stripe Tax. **[S]**
- **Any German tax law change between my sources and today** that the statute pages do not yet show. **[U]**

## 13. Sources

[3]: https://www.gesetze-im-internet.de/ustg_1980/__3.html
[3c]: https://www.gesetze-im-internet.de/ustg_1980/__3c.html
[4]: https://www.gesetze-im-internet.de/ustg_1980/__4.html
[6]: https://www.gesetze-im-internet.de/ustg_1980/__6.html
[6a]: https://www.gesetze-im-internet.de/ustg_1980/__6a.html
[13]: https://www.gesetze-im-internet.de/ustg_1980/__13.html
[13b]: https://www.gesetze-im-internet.de/ustg_1980/__13b.html
[14]: https://www.gesetze-im-internet.de/ustg_1980/__14.html
[14a]: https://www.gesetze-im-internet.de/ustg_1980/__14a.html
[14b]: https://www.gesetze-im-internet.de/ustg_1980/__14b.html
[14c]: https://www.gesetze-im-internet.de/ustg_1980/__14c.html
[17]: https://www.gesetze-im-internet.de/ustg_1980/__17.html
[18a]: https://www.gesetze-im-internet.de/ustg_1980/__18a.html
[18e]: https://www.gesetze-im-internet.de/ustg_1980/__18e.html
[18j]: https://www.gesetze-im-internet.de/ustg_1980/__18j.html
[19]: https://www.gesetze-im-internet.de/ustg_1980/__19.html
[19a]: https://www.gesetze-im-internet.de/ustg_1980/__19a.html
[22]: https://www.gesetze-im-internet.de/ustg_1980/__22.html
[27]: https://www.gesetze-im-internet.de/ustg_1980/__27.html
[10]: https://www.gesetze-im-internet.de/ustdv_1980/__10.html
[17a]: https://www.gesetze-im-internet.de/ustdv_1980/__17a.html
[31]: https://www.gesetze-im-internet.de/ustdv_1980/__31.html
[32]: https://www.gesetze-im-internet.de/ustdv_1980/__32.html
[33]: https://www.gesetze-im-internet.de/ustdv_1980/__33.html
[34a]: https://www.gesetze-im-internet.de/ustdv_1980/__34a.html
[147]: https://www.gesetze-im-internet.de/ao_1977/__147.html
[257]: https://www.gesetze-im-internet.de/hgb/__257.html
[356a]: https://www.gesetze-im-internet.de/bgb/__356a.html
[357]: https://www.gesetze-im-internet.de/bgb/__357.html
[357a]: https://www.gesetze-im-internet.de/bgb/__357a.html
[ae11]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/I-Steuergegenstand-und-Geltungsbereich/Paragraf-1/ae-1-1.html
[ae310]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/I-Steuergegenstand-und-Geltungsbereich/Paragraf-3/ae-3-10.html
[ae317]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/I-Steuergegenstand-und-Geltungsbereich/Paragraf-3/ae-3-17.html
[ae3c]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/I-Steuergegenstand-und-Geltungsbereich/Paragraf-3c/ae-3c-1.html
[ae101]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/III-Bemessungsgrundlagen/Paragraf-10/ae-10-1.html
[ae103]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/III-Bemessungsgrundlagen/Paragraf-10/ae-10-3.html
[ae143]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/IV-Steuer-und-Vorsteuer/Paragraf-14/ae-14-3.html
[ae145]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/IV-Steuer-und-Vorsteuer/Paragraf-14/ae-14-5.html
[ae1411]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/IV-Steuer-und-Vorsteuer/Paragraf-14/ae-14-11.html
[ae14c1]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/IV-Steuer-und-Vorsteuer/Paragraf-14c/ae-14c-1.html
[ae131]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/IV-Steuer-und-Vorsteuer/Paragraf-13/ae-13-1.html
[ae171]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/V-Besteuerung/Paragraf-17/ae-17-1.html
[ae18j]: https://usth.bundesfinanzministerium.de/usth/2024/A-Umsatzsteuergesetz/V-Besteuerung/Paragraf-18j/ae-18j-1.html
[bmf2026]: https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Umsatzsteuer/Umsatzsteuer-Anwendungserlass/2026-10-15-obligatorische-elektronische-rechnung.pdf?__blob=publicationFile&v=1
[bzst]: https://www.bzst.de/DE/Unternehmen/Umsatzsteuer/One-Stop-Shop_EU/one_stop_shop_eu_node.html
[art78]: https://www.legislation.gov.uk/eudr/2006/112/article/78
[art79]: https://www.legislation.gov.uk/eudr/2006/112/article/79
[art90]: https://www.legislation.gov.uk/eudr/2006/112/article/90
[en16931]: https://github.com/ConnectingEurope/eInvoicing-EN16931/blob/master/ubl/schematron/preprocessed/EN16931-UBL-validation-preprocessed.sch
[bfh2222]: https://www.rechtslupe.de/steuerrecht/ust/der-einheitliche-gesamtpreis-und-seine-aufteilung-nach-bruttoverkaufspreisen-3307220
[ahold]: https://www.vatupdate.com/2022/06/11/flashback-on-ecj-cases-c-484-06-koninklijke-ahold-no-obligation-to-round-down-the-amount-of-vat-per-item/
[haufe-round]: https://haufe.de/id/kommentar/berechnung-des-geschuldeten-steuerbetrags-rundung-von-betraegen-HI2134550.html
[haufe2026]: https://www.haufe.de/steuern/finanzverwaltung/bmf-ergaenzende-regelungen-zur-e-rechnung_164_700638.html
[xi]: https://www.iww.de/pistb/steuerrecht-aktuell/innergemeinschaftlicher-handel-lieferungen-nach-nordirland-neuer-30-ustg-regelt-die-pruefung-der-ust-idnr-f167900
[juraforum]: https://www.juraforum.de/lexikon/e-commerce-umsatzsteuer

- Statutes: [UStG][14], [UStDV][33], [AO][147], [HGB][257], [BGB][357] at gesetze-im-internet.de, reached 2026-11-01.
- Tax administration: [BMF handbook 2024][ae145], [BMF letter of 15 October 2026][bmf2026], [BZSt on OSS][bzst].
- EU: [Directive 2006/112/EC, retained copy][art78], [EN 16931 validation rules][en16931].
- Secondary, marked [U] or [S/U] where used: [Rechtslupe][bfh2222], [VATupdate][ahold], [Haufe on rounding][haufe-round], [Haufe on the 2026 letter][haufe2026], [IWW on Northern Ireland][xi], [Juraforum][juraforum].
