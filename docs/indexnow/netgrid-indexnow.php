<?php
/**
 * Plugin Name: NetGrid IndexNow Key
 * Description: Serves this site's IndexNow key file at the document root as
 *              text/plain, and exposes an authenticated REST route so NetGrid
 *              can set or rotate the key without filesystem access.
 * Version:     1.0.0
 * Author:      NetGrid
 *
 * INSTALL: copy this file to wp-content/mu-plugins/netgrid-indexnow.php
 *          (create the directory if it does not exist). Must-use plugins load
 *          automatically and cannot be deactivated from wp-admin. WordPress
 *          does NOT recurse into subdirectories of mu-plugins.
 *
 * WHY ROOT: IndexNow scopes a key file to its own directory. A key under
 * /wp-content/uploads/ authorises only /wp-content/uploads/**, which covers
 * no post permalinks. It has to be at the root.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('NETGRID_INDEXNOW_OPTION', 'netgrid_indexnow_key');

/**
 * Capability required to read/write the key over REST. Filterable for sites
 * where NetGrid authenticates as an Editor rather than an Administrator:
 *
 *     add_filter('netgrid_indexnow_capability', fn() => 'edit_posts');
 */
function netgrid_indexnow_capability() {
    return apply_filters('netgrid_indexnow_capability', 'manage_options');
}

/** The public URL of this site's key file, or '' when no key is set. */
function netgrid_indexnow_key_location() {
    $key = get_option(NETGRID_INDEXNOW_OPTION, '');
    if (!is_string($key) || $key === '') {
        return '';
    }
    return home_url('/' . $key . '.txt');
}

/**
 * Serve https://<host>/<key>.txt with the key as the ENTIRE body.
 *
 * Runs at priority 0 on init so it fires before the query is parsed and
 * before any theme/plugin can emit output. Standard WordPress rewrite rules
 * ('try_files $uri $uri/ /index.php' on nginx, the !-f condition in the
 * default .htaccess) route a request for a non-existent .txt file here.
 */
add_action('init', function () {
    $key = get_option(NETGRID_INDEXNOW_OPTION, '');
    if (!is_string($key) || $key === '') {
        return;
    }

    $raw  = isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '';
    $path = parse_url($raw, PHP_URL_PATH);
    if (!is_string($path)) {
        return;
    }

    // Compare against the path relative to the WP install root, so this also
    // works for WordPress in a subdirectory.
    $home_path = parse_url(home_url('/'), PHP_URL_PATH);
    $home_path = is_string($home_path) ? $home_path : '/';
    if (strpos($path, $home_path) === 0) {
        $path = substr($path, strlen($home_path));
    }
    $path = trim($path, '/');

    if ($path !== $key . '.txt') {
        return;
    }

    if (!headers_sent()) {
        status_header(200);
        header('Content-Type: text/plain; charset=UTF-8');
        header('X-Robots-Tag: noindex');
        header('Cache-Control: public, max-age=3600');
        header('Content-Length: ' . strlen($key));
    }
    echo $key;
    exit;
}, 0);

/**
 * REST: GET/POST /wp-json/netgrid/v1/indexnow-key
 *
 * POST { "key": "<8-128 chars of [a-zA-Z0-9-]>" }
 *   -> 200 { "key": "...", "key_location": "https://host/KEY.txt",
 *            "home_url": "https://host/" }
 */
add_action('rest_api_init', function () {
    register_rest_route('netgrid/v1', '/indexnow-key', array(
        array(
            'methods'             => 'GET',
            'permission_callback' => function () {
                return current_user_can(netgrid_indexnow_capability());
            },
            'callback'            => function () {
                return array(
                    'key'          => (string) get_option(NETGRID_INDEXNOW_OPTION, ''),
                    'key_location' => netgrid_indexnow_key_location(),
                    'home_url'     => home_url('/'),
                );
            },
        ),
        array(
            'methods'             => 'POST',
            'permission_callback' => function () {
                return current_user_can(netgrid_indexnow_capability());
            },
            'args'                => array(
                'key' => array('required' => true, 'type' => 'string'),
            ),
            'callback'            => function ($request) {
                $key = trim((string) $request->get_param('key'));
                if (!preg_match('/^[a-zA-Z0-9-]{8,128}$/', $key)) {
                    return new WP_Error(
                        'netgrid_invalid_key',
                        'Key must be 8-128 characters of [a-zA-Z0-9-].',
                        array('status' => 400)
                    );
                }
                update_option(NETGRID_INDEXNOW_OPTION, $key, true);
                return array(
                    'key'          => $key,
                    'key_location' => netgrid_indexnow_key_location(),
                    'home_url'     => home_url('/'),
                );
            },
        ),
    ));
});
