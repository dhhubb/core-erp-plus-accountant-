-- M1: indexes.
--
-- Branch-scoped high-volume tables: (org_id, branch_id, created_at DESC, id DESC).
-- Org-scoped tables:                    (org_id, created_at DESC, id DESC).
-- Business keys: composite unique indexes (branches, products, chart_of_accounts, ...).
-- Every foreign key column gets an index.

-- --- org-scoped: (org_id, created_at desc, id desc) -----------------------------------------
create index organizations_org_created_idx   on public.organizations   (org_id, created_at desc, id desc);
create index branches_org_created_idx        on public.branches        (org_id, created_at desc, id desc);
create index memberships_org_created_idx     on public.memberships     (org_id, created_at desc, id desc);
create index invites_org_created_idx         on public.invites         (org_id, created_at desc, id desc);
create index settings_org_created_idx        on public.settings        (org_id, created_at desc, id desc);
create index number_series_org_created_idx   on public.number_series   (org_id, created_at desc, id desc);
create index products_org_created_idx        on public.products        (org_id, created_at desc, id desc);
create index product_variants_org_created_idx on public.product_variants (org_id, created_at desc, id desc);
create index contacts_org_created_idx        on public.contacts        (org_id, created_at desc, id desc);
create index chart_of_accounts_org_created_idx on public.chart_of_accounts (org_id, created_at desc, id desc);
create index tax_rates_org_created_idx       on public.tax_rates       (org_id, created_at desc, id desc);
create index exchange_rates_org_created_idx  on public.exchange_rates  (org_id, created_at desc, id desc);
create index fiscal_periods_org_created_idx  on public.fiscal_periods  (org_id, created_at desc, id desc);

-- --- branch-scoped high-volume: (org_id, branch_id, created_at desc, id desc) ---------------
create index warehouses_org_branch_created_idx           on public.warehouses           (org_id, branch_id, created_at desc, id desc);
create index stock_ledger_org_branch_created_idx          on public.stock_ledger         (org_id, branch_id, created_at desc, id desc);
create index stock_consumptions_org_branch_created_idx    on public.stock_consumptions   (org_id, branch_id, created_at desc, id desc);
create index stock_balances_org_branch_created_idx        on public.stock_balances       (org_id, branch_id, created_at desc, id desc);
create index stock_layer_balances_org_branch_created_idx  on public.stock_layer_balances (org_id, branch_id, created_at desc, id desc);
create index stock_transfers_org_branch_created_idx       on public.stock_transfers      (org_id, branch_id, created_at desc, id desc);
create index journals_org_branch_created_idx              on public.journals             (org_id, branch_id, created_at desc, id desc);
create index journal_lines_org_branch_created_idx         on public.journal_lines        (org_id, branch_id, created_at desc, id desc);
create index sales_orders_org_branch_created_idx          on public.sales_orders         (org_id, branch_id, created_at desc, id desc);
create index invoices_org_branch_created_idx              on public.invoices             (org_id, branch_id, created_at desc, id desc);
create index invoice_lines_org_branch_created_idx         on public.invoice_lines        (org_id, branch_id, created_at desc, id desc);
create index payments_org_branch_created_idx              on public.payments             (org_id, branch_id, created_at desc, id desc);
create index credit_notes_org_branch_created_idx          on public.credit_notes         (org_id, branch_id, created_at desc, id desc);
create index purchase_orders_org_branch_created_idx       on public.purchase_orders      (org_id, branch_id, created_at desc, id desc);
create index audit_logs_org_branch_created_idx            on public.audit_logs           (org_id, branch_id, created_at desc, id desc);

-- --- foreign key columns --------------------------------------------------------------------
create index branches_org_id_idx              on public.branches (org_id);
create index memberships_org_id_idx           on public.memberships (org_id);
create index memberships_user_id_idx          on public.memberships (user_id);
create index invites_org_id_idx               on public.invites (org_id);
create index invites_created_by_idx           on public.invites (created_by);
create index number_series_org_id_idx         on public.number_series (org_id);
create index settings_org_id_idx              on public.settings (org_id);
create index products_org_id_idx              on public.products (org_id);
create index product_variants_org_id_idx      on public.product_variants (org_id);
create index product_variants_product_id_idx  on public.product_variants (product_id);
create index contacts_org_id_idx              on public.contacts (org_id);
create index chart_of_accounts_org_id_idx     on public.chart_of_accounts (org_id);
create index chart_of_accounts_parent_id_idx  on public.chart_of_accounts (parent_id);
create index tax_rates_org_id_idx             on public.tax_rates (org_id);
create index exchange_rates_org_id_idx        on public.exchange_rates (org_id);
create index fiscal_periods_org_id_idx        on public.fiscal_periods (org_id);

create index warehouses_org_id_idx            on public.warehouses (org_id);
create index warehouses_branch_id_idx         on public.warehouses (branch_id);
create index stock_ledger_org_id_idx          on public.stock_ledger (org_id);
create index stock_ledger_branch_id_idx       on public.stock_ledger (branch_id);
create index stock_ledger_warehouse_id_idx    on public.stock_ledger (warehouse_id);
create index stock_ledger_product_id_idx      on public.stock_ledger (product_id);
create index stock_ledger_variant_id_idx      on public.stock_ledger (variant_id);
-- FIFO lookup: oldest remaining inbound layer for a warehouse/product.
create index stock_ledger_layer_idx           on public.stock_ledger (org_id, warehouse_id, product_id, variant_id, created_at, id)
  where direction = 'in';

create index stock_consumptions_org_id_idx    on public.stock_consumptions (org_id);
create index stock_consumptions_branch_id_idx on public.stock_consumptions (branch_id);
create index stock_consumptions_warehouse_id_idx on public.stock_consumptions (warehouse_id);
create index stock_consumptions_product_id_idx on public.stock_consumptions (product_id);
create index stock_consumptions_variant_id_idx on public.stock_consumptions (variant_id);
create index stock_consumptions_out_idx       on public.stock_consumptions (out_ledger_id, out_ledger_created_at);
create index stock_consumptions_in_idx        on public.stock_consumptions (in_ledger_id, in_ledger_created_at);

create index stock_balances_org_id_idx        on public.stock_balances (org_id);
create index stock_balances_branch_id_idx     on public.stock_balances (branch_id);
create index stock_balances_warehouse_id_idx  on public.stock_balances (warehouse_id);
create index stock_balances_product_id_idx    on public.stock_balances (product_id);
create index stock_balances_variant_id_idx    on public.stock_balances (variant_id);

create index stock_layer_balances_org_id_idx       on public.stock_layer_balances (org_id);
create index stock_layer_balances_branch_id_idx    on public.stock_layer_balances (branch_id);
create index stock_layer_balances_warehouse_id_idx on public.stock_layer_balances (warehouse_id);
create index stock_layer_balances_product_id_idx   on public.stock_layer_balances (product_id);
create index stock_layer_balances_variant_id_idx   on public.stock_layer_balances (variant_id);
create index stock_layer_balances_in_idx           on public.stock_layer_balances (in_ledger_id, in_ledger_created_at);

create index stock_transfers_org_id_idx            on public.stock_transfers (org_id);
create index stock_transfers_branch_id_idx         on public.stock_transfers (branch_id);
create index stock_transfers_from_warehouse_id_idx on public.stock_transfers (from_warehouse_id);
create index stock_transfers_to_warehouse_id_idx   on public.stock_transfers (to_warehouse_id);
create index stock_transfers_product_id_idx        on public.stock_transfers (product_id);
create index stock_transfers_variant_id_idx        on public.stock_transfers (variant_id);

create index journals_org_id_idx              on public.journals (org_id);
create index journals_branch_id_idx           on public.journals (branch_id);
create index journals_reversal_of_idx         on public.journals (reversal_of, reversal_created_at);
create index journals_source_idx              on public.journals (org_id, source_type, source_id);

create index journal_lines_journal_idx        on public.journal_lines (journal_id, journal_created_at);
create index journal_lines_org_id_idx         on public.journal_lines (org_id);
create index journal_lines_branch_id_idx      on public.journal_lines (branch_id);
create index journal_lines_account_id_idx     on public.journal_lines (account_id);
create index journal_lines_tax_rate_id_idx    on public.journal_lines (tax_rate_id);
-- Report predicate. posting_date narrows the rows; created_at prunes the partitions.
create index journal_lines_report_idx         on public.journal_lines (org_id, posting_date, account_id);

create index sales_orders_org_id_idx          on public.sales_orders (org_id);
create index sales_orders_branch_id_idx       on public.sales_orders (branch_id);
create index sales_orders_contact_id_idx      on public.sales_orders (contact_id);

create index invoices_org_id_idx              on public.invoices (org_id);
create index invoices_branch_id_idx           on public.invoices (branch_id);
create index invoices_contact_id_idx          on public.invoices (contact_id);
create index invoices_sales_order_id_idx      on public.invoices (sales_order_id);
create index invoices_journal_idx             on public.invoices (journal_id, journal_created_at);
create index invoices_open_idx                on public.invoices (org_id, contact_id) where total > amount_paid;

create index invoice_lines_org_id_idx         on public.invoice_lines (org_id);
create index invoice_lines_branch_id_idx      on public.invoice_lines (branch_id);
create index invoice_lines_invoice_id_idx     on public.invoice_lines (invoice_id);
create index invoice_lines_product_id_idx     on public.invoice_lines (product_id);
create index invoice_lines_variant_id_idx     on public.invoice_lines (variant_id);
create index invoice_lines_warehouse_id_idx   on public.invoice_lines (warehouse_id);
create index invoice_lines_tax_rate_id_idx    on public.invoice_lines (tax_rate_id);

create index payments_org_id_idx              on public.payments (org_id);
create index payments_branch_id_idx           on public.payments (branch_id);
create index payments_contact_id_idx          on public.payments (contact_id);
create index payments_invoice_id_idx          on public.payments (invoice_id);
create index payments_journal_idx             on public.payments (journal_id, journal_created_at);

create index credit_notes_org_id_idx          on public.credit_notes (org_id);
create index credit_notes_branch_id_idx       on public.credit_notes (branch_id);
create index credit_notes_invoice_id_idx      on public.credit_notes (invoice_id);
create index credit_notes_journal_idx         on public.credit_notes (journal_id, journal_created_at);

create index purchase_orders_org_id_idx       on public.purchase_orders (org_id);
create index purchase_orders_branch_id_idx    on public.purchase_orders (branch_id);
create index purchase_orders_contact_id_idx   on public.purchase_orders (contact_id);

create index audit_logs_org_id_idx            on public.audit_logs (org_id);
create index audit_logs_branch_id_idx         on public.audit_logs (branch_id);
