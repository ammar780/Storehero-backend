<?php
/**
 * Plugin Name: TVS Profit Dashboard Connector
 * Plugin URI: https://thevitaminshots.com
 * Description: Connects WooCommerce to TVS Profit Dashboard. Sends order webhooks, syncs COGS, and provides product cost management in WooCommerce admin.
 * Version: 1.0.0
 * Author: The Vitamin Shots
 * Requires at least: 5.8
 * Requires PHP: 7.4
 * WC requires at least: 5.0
 * Text Domain: tvs-profit-dashboard
 */

if (!defined('ABSPATH')) exit;

class TVS_Profit_Dashboard {

    private static $instance = null;
    private $api_url;
    private $api_secret;

    public static function instance() {
        if (self::$instance === null) {
            self::$instance = new self();
        }
        return self::$instance;
    }

    private function __construct() {
        $this->api_url = get_option('tvs_dashboard_api_url', '');
        $this->api_secret = get_option('tvs_dashboard_api_secret', '');

        // Admin settings page
        add_action('admin_menu', [$this, 'add_admin_menu']);
        add_action('admin_init', [$this, 'register_settings']);

        // WooCommerce product COGS field
        add_action('woocommerce_product_options_pricing', [$this, 'add_cogs_field']);
        add_action('woocommerce_process_product_meta', [$this, 'save_cogs_field']);
        add_action('woocommerce_variation_options_pricing', [$this, 'add_variation_cogs_field'], 10, 3);
        add_action('woocommerce_save_product_variation', [$this, 'save_variation_cogs_field'], 10, 2);

        // WooCommerce product list column
        add_filter('manage_edit-product_columns', [$this, 'add_cogs_column']);
        add_action('manage_product_posts_custom_column', [$this, 'render_cogs_column'], 10, 2);

        // Bulk COGS editor
        add_action('admin_footer-edit.php', [$this, 'bulk_cogs_script']);

        // Order webhooks
        add_action('woocommerce_order_status_completed', [$this, 'send_order_webhook'], 10, 1);
        add_action('woocommerce_order_status_processing', [$this, 'send_order_webhook'], 10, 1);
        add_action('woocommerce_order_status_refunded', [$this, 'send_order_webhook'], 10, 1);

        // Sync COGS to backend when saved
        add_action('woocommerce_process_product_meta', [$this, 'sync_cogs_to_backend'], 20);

        // Admin bar quick stats
        add_action('admin_bar_menu', [$this, 'admin_bar_link'], 100);

        // Dashboard widget
        add_action('wp_dashboard_setup', [$this, 'add_dashboard_widget']);

        // REST API endpoints for backend to call
        add_action('rest_api_init', [$this, 'register_rest_routes']);
    }

    // ── Settings Page ──
    public function add_admin_menu() {
        add_menu_page(
            'TVS Dashboard',
            'TVS Dashboard',
            'manage_woocommerce',
            'tvs-dashboard',
            [$this, 'settings_page'],
            'dashicons-chart-area',
            56
        );
        add_submenu_page('tvs-dashboard', 'COGS Manager', 'COGS Manager', 'manage_woocommerce', 'tvs-cogs-manager', [$this, 'cogs_manager_page']);
        add_submenu_page('tvs-dashboard', 'Sync Status', 'Sync Status', 'manage_woocommerce', 'tvs-sync-status', [$this, 'sync_status_page']);
    }

    public function register_settings() {
        register_setting('tvs_dashboard_settings', 'tvs_dashboard_api_url');
        register_setting('tvs_dashboard_settings', 'tvs_dashboard_api_secret');
        register_setting('tvs_dashboard_settings', 'tvs_dashboard_auto_sync');
        register_setting('tvs_dashboard_settings', 'tvs_dashboard_default_fee_pct');
    }

    public function settings_page() {
        $connected = $this->test_connection();
        ?>
        <div class="wrap">
            <h1>TVS Profit Dashboard Settings</h1>
            <div class="notice notice-info"><p>Connect your WooCommerce store to TVS Profit Dashboard for real-time profit analytics.</p></div>

            <?php if ($connected): ?>
                <div class="notice notice-success"><p><strong>&#10004; Connected</strong> to dashboard backend successfully.</p></div>
            <?php elseif ($this->api_url): ?>
                <div class="notice notice-error"><p><strong>&#10008; Connection failed.</strong> Check your API URL and secret.</p></div>
            <?php endif; ?>

            <form method="post" action="options.php">
                <?php settings_fields('tvs_dashboard_settings'); ?>
                <table class="form-table">
                    <tr>
                        <th>Dashboard API URL</th>
                        <td>
                            <input type="url" name="tvs_dashboard_api_url" value="<?php echo esc_attr($this->api_url); ?>" class="regular-text" placeholder="https://your-backend.up.railway.app" />
                            <p class="description">Your Railway backend URL (no trailing slash)</p>
                        </td>
                    </tr>
                    <tr>
                        <th>API Secret</th>
                        <td>
                            <input type="password" name="tvs_dashboard_api_secret" value="<?php echo esc_attr($this->api_secret); ?>" class="regular-text" />
                            <p class="description">Must match PLUGIN_API_SECRET on your backend</p>
                        </td>
                    </tr>
                    <tr>
                        <th>Auto-sync orders</th>
                        <td>
                            <label><input type="checkbox" name="tvs_dashboard_auto_sync" value="1" <?php checked(get_option('tvs_dashboard_auto_sync'), 1); ?> /> Send order data automatically when orders are completed/processing</label>
                        </td>
                    </tr>
                    <tr>
                        <th>Default Payment Fee %</th>
                        <td>
                            <input type="number" step="0.1" name="tvs_dashboard_default_fee_pct" value="<?php echo esc_attr(get_option('tvs_dashboard_default_fee_pct', '2.9')); ?>" class="small-text" />%
                            <p class="description">Default payment processing fee (e.g., 2.9 for Stripe)</p>
                        </td>
                    </tr>
                </table>
                <?php submit_button('Save Settings'); ?>
            </form>

            <hr>
            <h2>Manual Actions</h2>
            <p>
                <a href="<?php echo esc_url($this->api_url); ?>" target="_blank" class="button">Open Dashboard API</a>
                <button type="button" class="button button-primary" onclick="tvsTriggerSync()">Trigger Full Sync</button>
            </p>
            <script>
            function tvsTriggerSync() {
                if (!confirm('This will sync ALL products and orders to the dashboard. Continue?')) return;
                fetch('<?php echo esc_url(rest_url('tvs-dashboard/v1/trigger-sync')); ?>', {
                    method: 'POST',
                    headers: {'X-WP-Nonce': '<?php echo wp_create_nonce('wp_rest'); ?>'}
                }).then(r => r.json()).then(d => alert(d.message || 'Sync triggered!')).catch(e => alert('Error: ' + e));
            }
            </script>
        </div>
        <?php
    }

    // ── COGS Field in Product Editor ──
    public function add_cogs_field() {
        woocommerce_wp_text_input([
            'id' => '_tvs_cogs',
            'label' => 'Cost of Goods (COGS) ($)',
            'desc_tip' => true,
            'description' => 'Unit cost including materials, manufacturing, packaging. Used for profit calculations in TVS Dashboard.',
            'type' => 'number',
            'custom_attributes' => ['step' => '0.01', 'min' => '0'],
            'value' => get_post_meta(get_the_ID(), '_tvs_cogs', true),
        ]);
        // Shipping cost per unit
        woocommerce_wp_text_input([
            'id' => '_tvs_shipping_cost',
            'label' => 'Shipping Cost per Unit ($)',
            'desc_tip' => true,
            'description' => 'Average shipping cost per unit for this product.',
            'type' => 'number',
            'custom_attributes' => ['step' => '0.01', 'min' => '0'],
            'value' => get_post_meta(get_the_ID(), '_tvs_shipping_cost', true),
        ]);
    }

    public function save_cogs_field($post_id) {
        if (isset($_POST['_tvs_cogs'])) {
            update_post_meta($post_id, '_tvs_cogs', sanitize_text_field($_POST['_tvs_cogs']));
        }
        if (isset($_POST['_tvs_shipping_cost'])) {
            update_post_meta($post_id, '_tvs_shipping_cost', sanitize_text_field($_POST['_tvs_shipping_cost']));
        }
    }

    public function add_variation_cogs_field($loop, $variation_data, $variation) {
        woocommerce_wp_text_input([
            'id' => "_tvs_variation_cogs_{$loop}",
            'name' => "_tvs_variation_cogs[{$loop}]",
            'label' => 'COGS ($)',
            'value' => get_post_meta($variation->ID, '_tvs_cogs', true),
            'type' => 'number',
            'custom_attributes' => ['step' => '0.01', 'min' => '0'],
            'wrapper_class' => 'form-row form-row-first',
        ]);
    }

    public function save_variation_cogs_field($variation_id, $loop) {
        if (isset($_POST['_tvs_variation_cogs'][$loop])) {
            update_post_meta($variation_id, '_tvs_cogs', sanitize_text_field($_POST['_tvs_variation_cogs'][$loop]));
        }
    }

    // ── COGS Column in Product List ──
    public function add_cogs_column($columns) {
        $new = [];
        foreach ($columns as $k => $v) {
            $new[$k] = $v;
            if ($k === 'price') {
                $new['tvs_cogs'] = 'COGS';
                $new['tvs_margin'] = 'Margin';
            }
        }
        return $new;
    }

    public function render_cogs_column($column, $post_id) {
        if ($column === 'tvs_cogs') {
            $cogs = get_post_meta($post_id, '_tvs_cogs', true);
            echo $cogs ? '$' . number_format((float)$cogs, 2) : '<span style="color:#999">—</span>';
        }
        if ($column === 'tvs_margin') {
            $product = wc_get_product($post_id);
            $price = $product ? (float)$product->get_price() : 0;
            $cogs = (float)get_post_meta($post_id, '_tvs_cogs', true);
            if ($price > 0 && $cogs > 0) {
                $margin = (($price - $cogs) / $price) * 100;
                $color = $margin > 50 ? '#46b450' : ($margin > 25 ? '#f0b849' : '#dc3232');
                echo '<span style="color:' . $color . ';font-weight:bold">' . number_format($margin, 1) . '%</span>';
            } else {
                echo '<span style="color:#999">—</span>';
            }
        }
    }

    // ── Bulk COGS editor script ──
    public function bulk_cogs_script() {
        global $typenow;
        if ($typenow !== 'product') return;
        ?>
        <script>
        jQuery(function($) {
            // Quick edit COGS
            $('.editinline').on('click', function() {
                var id = $(this).closest('tr').attr('id').replace('post-', '');
                var cogs = $('#post-' + id + ' .column-tvs_cogs').text().replace('$', '').trim();
                setTimeout(function() {
                    if ($('#tvs-quick-cogs').length === 0) {
                        $('.inline-edit-col-right .inline-edit-group:last').append(
                            '<label class="alignleft"><span class="title">COGS ($)</span>' +
                            '<input type="number" step="0.01" id="tvs-quick-cogs" name="_tvs_cogs" value="' + (cogs === '—' ? '' : cogs) + '" /></label>'
                        );
                    }
                }, 100);
            });
        });
        </script>
        <?php
    }

    // ── Order Webhooks ──
    public function send_order_webhook($order_id) {
        if (!get_option('tvs_dashboard_auto_sync')) return;
        if (!$this->api_url) return;

        $order = wc_get_order($order_id);
        if (!$order) return;

        $items = [];
        foreach ($order->get_items() as $item) {
            $product_id = $item->get_product_id();
            $cogs = (float)get_post_meta($product_id, '_tvs_cogs', true);
            $items[] = [
                'product_id' => $product_id,
                'name' => $item->get_name(),
                'sku' => $item->get_product() ? $item->get_product()->get_sku() : '',
                'quantity' => $item->get_quantity(),
                'total' => (float)$item->get_total(),
                'cogs' => $cogs,
                'line_cogs' => $cogs * $item->get_quantity(),
            ];
        }

        $payload = [
            'id' => $order->get_id(),
            'status' => $order->get_status(),
            'date_created' => $order->get_date_created()->format('c'),
            'total' => $order->get_total(),
            'shipping_total' => $order->get_shipping_total(),
            'discount_total' => $order->get_discount_total(),
            'total_tax' => $order->get_total_tax(),
            'payment_method' => $order->get_payment_method(),
            'currency' => $order->get_currency(),
            'customer_id' => $order->get_customer_id(),
            'billing' => [
                'email' => $order->get_billing_email(),
                'first_name' => $order->get_billing_first_name(),
                'last_name' => $order->get_billing_last_name(),
                'country' => $order->get_billing_country(),
                'state' => $order->get_billing_state(),
                'city' => $order->get_billing_city(),
            ],
            'coupon_lines' => array_map(function($c) { return ['code' => $c->get_code()]; }, $order->get_coupons()),
            'line_items' => $items,
            'meta_data' => [
                ['key' => '_utm_source', 'value' => get_post_meta($order_id, '_utm_source', true)],
                ['key' => '_utm_medium', 'value' => get_post_meta($order_id, '_utm_medium', true)],
                ['key' => '_utm_campaign', 'value' => get_post_meta($order_id, '_utm_campaign', true)],
            ],
        ];

        wp_remote_post($this->api_url . '/api/webhooks/woocommerce', [
            'timeout' => 15,
            'headers' => [
                'Content-Type' => 'application/json',
                'X-WC-Webhook-Topic' => 'order.' . $order->get_status(),
                'X-Plugin-Secret' => $this->api_secret,
            ],
            'body' => json_encode($payload),
        ]);
    }

    // ── Sync COGS to Backend ──
    public function sync_cogs_to_backend($post_id) {
        if (!$this->api_url || !$this->api_secret) return;

        $product = wc_get_product($post_id);
        if (!$product) return;

        wp_remote_post($this->api_url . '/api/plugin/cogs', [
            'timeout' => 10,
            'headers' => [
                'Content-Type' => 'application/json',
                'X-Plugin-Secret' => $this->api_secret,
            ],
            'body' => json_encode([
                'woo_product_id' => $post_id,
                'cogs' => (float)get_post_meta($post_id, '_tvs_cogs', true),
                'shipping_cost' => (float)get_post_meta($post_id, '_tvs_shipping_cost', true),
                'name' => $product->get_name(),
                'sku' => $product->get_sku(),
                'price' => (float)$product->get_price(),
            ]),
        ]);
    }

    // ── COGS Manager Page ──
    public function cogs_manager_page() {
        $products = wc_get_products(['limit' => -1, 'status' => 'publish', 'orderby' => 'name', 'order' => 'ASC']);

        if (isset($_POST['tvs_bulk_cogs_save']) && wp_verify_nonce($_POST['_wpnonce'], 'tvs_bulk_cogs')) {
            foreach ($_POST['cogs'] as $pid => $val) {
                update_post_meta($pid, '_tvs_cogs', sanitize_text_field($val));
            }
            echo '<div class="notice notice-success"><p>COGS updated for ' . count($_POST['cogs']) . ' products!</p></div>';
            $products = wc_get_products(['limit' => -1, 'status' => 'publish', 'orderby' => 'name', 'order' => 'ASC']);
        }
        ?>
        <div class="wrap">
            <h1>COGS Manager</h1>
            <p>Set cost of goods for all products in one place. This data feeds into your profit calculations.</p>
            <form method="post">
                <?php wp_nonce_field('tvs_bulk_cogs'); ?>
                <table class="wp-list-table widefat fixed striped">
                    <thead><tr><th>Product</th><th>SKU</th><th>Price</th><th style="width:120px">COGS ($)</th><th>Margin</th></tr></thead>
                    <tbody>
                    <?php foreach ($products as $p):
                        $cogs = (float)get_post_meta($p->get_id(), '_tvs_cogs', true);
                        $price = (float)$p->get_price();
                        $margin = ($price > 0 && $cogs > 0) ? (($price - $cogs) / $price * 100) : 0;
                    ?>
                    <tr>
                        <td><strong><?php echo esc_html($p->get_name()); ?></strong></td>
                        <td><?php echo esc_html($p->get_sku()); ?></td>
                        <td>$<?php echo number_format($price, 2); ?></td>
                        <td><input type="number" step="0.01" min="0" name="cogs[<?php echo $p->get_id(); ?>]" value="<?php echo esc_attr($cogs ?: ''); ?>" style="width:100%" /></td>
                        <td><?php echo $margin > 0 ? number_format($margin, 1) . '%' : '—'; ?></td>
                    </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
                <p class="submit"><input type="submit" name="tvs_bulk_cogs_save" class="button button-primary" value="Save All COGS" /></p>
            </form>
        </div>
        <?php
    }

    // ── Sync Status Page ──
    public function sync_status_page() {
        ?>
        <div class="wrap">
            <h1>Sync Status</h1>
            <table class="form-table">
                <tr><th>API URL</th><td><?php echo esc_html($this->api_url ?: 'Not configured'); ?></td></tr>
                <tr><th>Connection</th><td><?php echo $this->test_connection() ? '<span style="color:green">&#10004; Connected</span>' : '<span style="color:red">&#10008; Disconnected</span>'; ?></td></tr>
                <tr><th>Products with COGS</th><td><?php
                    global $wpdb;
                    $total = $wpdb->get_var("SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type='product' AND post_status='publish'");
                    $with_cogs = $wpdb->get_var("SELECT COUNT(DISTINCT post_id) FROM {$wpdb->postmeta} WHERE meta_key='_tvs_cogs' AND meta_value > 0");
                    echo "{$with_cogs} / {$total} products";
                ?></td></tr>
                <tr><th>Auto-sync</th><td><?php echo get_option('tvs_dashboard_auto_sync') ? 'Enabled' : 'Disabled'; ?></td></tr>
            </table>
        </div>
        <?php
    }

    // ── Admin Bar Link ──
    public function admin_bar_link($wp_admin_bar) {
        if (!current_user_can('manage_woocommerce')) return;
        $wp_admin_bar->add_node([
            'id' => 'tvs-dashboard',
            'title' => '📊 Profit Dashboard',
            'href' => admin_url('admin.php?page=tvs-dashboard'),
        ]);
    }

    // ── Dashboard Widget ──
    public function add_dashboard_widget() {
        wp_add_dashboard_widget('tvs_profit_widget', 'TVS Profit Dashboard', [$this, 'dashboard_widget']);
    }

    public function dashboard_widget() {
        if (!$this->api_url) {
            echo '<p>Please <a href="' . admin_url('admin.php?page=tvs-dashboard') . '">configure your dashboard</a> first.</p>';
            return;
        }
        echo '<p>View your full profit analytics:</p>';
        echo '<a href="' . admin_url('admin.php?page=tvs-dashboard') . '" class="button button-primary">Open Dashboard Settings</a> ';
        echo '<a href="' . admin_url('admin.php?page=tvs-cogs-manager') . '" class="button">Manage COGS</a>';
    }

    // ── REST API Routes ──
    public function register_rest_routes() {
        register_rest_route('tvs-dashboard/v1', '/trigger-sync', [
            'methods' => 'POST',
            'callback' => [$this, 'rest_trigger_sync'],
            'permission_callback' => function() { return current_user_can('manage_woocommerce'); },
        ]);
        register_rest_route('tvs-dashboard/v1', '/products', [
            'methods' => 'GET',
            'callback' => [$this, 'rest_get_products'],
            'permission_callback' => function() { return current_user_can('manage_woocommerce'); },
        ]);
    }

    public function rest_trigger_sync() {
        if (!$this->api_url) return new WP_REST_Response(['message' => 'API URL not configured'], 400);

        // Get a token first
        $login = wp_remote_post($this->api_url . '/api/plugin/heartbeat', [
            'headers' => ['Content-Type' => 'application/json', 'X-Plugin-Secret' => $this->api_secret],
            'body' => json_encode(['action' => 'trigger_sync']),
        ]);

        return new WP_REST_Response(['message' => 'Sync request sent to dashboard backend.'], 200);
    }

    public function rest_get_products() {
        $products = wc_get_products(['limit' => -1, 'status' => 'publish']);
        $data = [];
        foreach ($products as $p) {
            $data[] = [
                'id' => $p->get_id(),
                'name' => $p->get_name(),
                'sku' => $p->get_sku(),
                'price' => (float)$p->get_price(),
                'cogs' => (float)get_post_meta($p->get_id(), '_tvs_cogs', true),
                'shipping_cost' => (float)get_post_meta($p->get_id(), '_tvs_shipping_cost', true),
            ];
        }
        return new WP_REST_Response($data, 200);
    }

    // ── Test Connection ──
    private function test_connection() {
        if (!$this->api_url) return false;
        $response = wp_remote_get($this->api_url . '/health', ['timeout' => 5]);
        if (is_wp_error($response)) return false;
        $body = json_decode(wp_remote_retrieve_body($response), true);
        return isset($body['status']) && $body['status'] === 'healthy';
    }
}

// Initialize
add_action('plugins_loaded', function() {
    if (class_exists('WooCommerce')) {
        TVS_Profit_Dashboard::instance();
    }
});
