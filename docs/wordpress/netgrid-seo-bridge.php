<?php
/**
 * Plugin Name: NetGrid SEO Bridge
 * Description: Exposes Yoast SEO's post meta to the WordPress REST API so NetGrid can set the SEO title and meta description at publish time, and keeps Yoast's indexable cache in sync afterwards.
 * Version:     1.0.0
 * Author:      NetGrid
 * License:     GPL-2.0-or-later
 *
 * INSTALL: copy this single file to wp-content/mu-plugins/netgrid-seo-bridge.php
 * (create the directory if it does not exist). Must-use plugins load
 * automatically on every request and cannot be deactivated from wp-admin,
 * which is what we want on a managed network. Note that WordPress does NOT
 * recurse into subdirectories of mu-plugins - the file must sit directly in it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Yoast stores its metabox fields as underscore-prefixed post meta
 * (WPSEO_Meta::$meta_prefix === '_yoast_wpseo_'). It does not register those
 * keys for the REST API. WP_REST_Meta_Fields::update_value() iterates over
 * REGISTERED meta only, so a wp/v2/posts request carrying unregistered keys is
 * accepted with HTTP 200 and the keys are discarded without an error.
 *
 * Underscore-prefixed keys are additionally "protected meta":
 * is_protected_meta() returns true, and map_meta_cap() denies edit_post_meta
 * for them unless the registration supplied an auth_callback. So both
 * show_in_rest AND an auth_callback are required. That is exactly what this
 * file adds.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'NETGRID_SEO_BRIDGE_VERSION', '1.0.0' );

/**
 * The Yoast post-meta keys we expose for REST writes.
 *
 * Keep this list minimal and additive. Every key here becomes writable by any
 * user who can edit the post, so do not add keys whose misuse could de-index a
 * site (notably _yoast_wpseo_meta-robots-noindex, which is deliberately absent).
 *
 * @return string[] meta_key => REST type
 */
function netgrid_seo_bridge_meta_keys() {
	return array(
		'_yoast_wpseo_title'                 => 'string',
		'_yoast_wpseo_metadesc'              => 'string',
		'_yoast_wpseo_focuskw'               => 'string',
		'_yoast_wpseo_canonical'             => 'string',
		'_yoast_wpseo_opengraph-title'       => 'string',
		'_yoast_wpseo_opengraph-description' => 'string',
		'_yoast_wpseo_twitter-title'         => 'string',
		'_yoast_wpseo_twitter-description'   => 'string',
	);
}

/**
 * Post types we bridge. Posts are what NetGrid publishes; pages are included
 * so later homepage/about-page SEO work does not need a second rollout.
 *
 * @return string[]
 */
function netgrid_seo_bridge_post_types() {
	return array( 'post', 'page' );
}

/**
 * auth_callback for the registered meta.
 *
 * Signature matches the auth_{object_type}_{object_subtype}_meta_{meta_key}
 * filter that register_meta() installs:
 *   ( $allowed, $meta_key, $object_id, $user_id, $cap, $caps )
 *
 * We grant the write to anyone who can edit that specific post - the same bar
 * WordPress applies to editing the post's title and body. No recursion risk:
 * 'edit_post' maps to edit_posts/edit_others_posts, never back to
 * edit_post_meta.
 *
 * @param bool   $allowed   Whether the key is considered public meta.
 * @param string $meta_key  The meta key being written.
 * @param int    $object_id Post ID.
 * @param int    $user_id   User attempting the write.
 * @return bool
 */
function netgrid_seo_bridge_auth( $allowed, $meta_key, $object_id, $user_id ) {
	unset( $allowed, $meta_key );
	if ( ! $object_id || ! $user_id ) {
		return false;
	}
	return user_can( $user_id, 'edit_post', (int) $object_id );
}

/**
 * Sanitize a meta title / description before storage. Strips tags and line
 * breaks and collapses runs of whitespace, matching what NetGrid already sends
 * and what a <title> / meta description can meaningfully contain.
 *
 * @param mixed $value Raw incoming value.
 * @return string
 */
function netgrid_seo_bridge_sanitize( $value ) {
	if ( ! is_string( $value ) ) {
		return '';
	}
	$value = wp_strip_all_tags( $value, true );
	$value = preg_replace( '/\s+/u', ' ', $value );
	return trim( (string) $value );
}

/**
 * Register the meta keys. Runs on 'init' (not at file load) because mu-plugins
 * load BEFORE regular plugins, so WPSEO_VERSION is not defined yet at that
 * point. By 'init' Yoast's main file has run and the constant is available.
 *
 * If Yoast is not active we register nothing - there is no consumer for the
 * meta, and registering protected keys on a site that does not need them is
 * needless surface area. The netgrid/v1/seo-bridge probe reports this state so
 * NetGrid can see it.
 */
function netgrid_seo_bridge_register_meta() {
	if ( ! defined( 'WPSEO_VERSION' ) ) {
		return;
	}
	foreach ( netgrid_seo_bridge_post_types() as $post_type ) {
		foreach ( netgrid_seo_bridge_meta_keys() as $meta_key => $type ) {
			register_post_meta(
				$post_type,
				$meta_key,
				array(
					'type'              => $type,
					'single'            => true,
					'show_in_rest'      => true,
					'default'           => '',
					'sanitize_callback' => 'netgrid_seo_bridge_sanitize',
					'auth_callback'     => 'netgrid_seo_bridge_auth',
				)
			);
		}
	}
}
add_action( 'init', 'netgrid_seo_bridge_register_meta', 20 );

/**
 * Refresh Yoast's indexable after a REST meta write.
 *
 * Yoast 14+ renders the head from the wp_yoast_indexable table, not from post
 * meta at request time. It rebuilds that row on wp_insert_post - and
 * WP_REST_Posts_Controller::update_item() fires wp_insert_post BEFORE it
 * applies the request's `meta`. Without this hook the meta is stored correctly
 * and the live page keeps rendering the previously-cached title/description.
 *
 * rest_after_insert_{post_type} fires after meta has been written, so we
 * rebuild here. Two strategies, in order of preference:
 *   1. Ask Yoast's own Indexable_Builder to rebuild in place.
 *   2. Delete the cached row so Yoast rebuilds it lazily on the next render.
 * Both are safe: the indexable is derived data, never a source of truth.
 *
 * @param WP_Post         $post    The updated post.
 * @param WP_REST_Request $request The request that updated it.
 * @return void
 */
function netgrid_seo_bridge_refresh_indexable( $post, $request ) {
	if ( ! is_object( $post ) || empty( $post->ID ) ) {
		return;
	}
	$meta = $request->get_param( 'meta' );
	if ( ! is_array( $meta ) ) {
		return;
	}
	$touched = array_intersect( array_keys( $meta ), array_keys( netgrid_seo_bridge_meta_keys() ) );
	if ( empty( $touched ) ) {
		return;
	}

	$post_id = (int) $post->ID;
	// Yoast stores both posts and pages under object_type 'post'; the
	// post_type is carried separately in object_sub_type.
	$object_type = 'post';

	// 1. Preferred: rebuild through Yoast's own builder.
	if (
		function_exists( 'YoastSEO' )
		&& class_exists( '\Yoast\WP\SEO\Builders\Indexable_Builder' )
		&& class_exists( '\Yoast\WP\SEO\Repositories\Indexable_Repository' )
	) {
		try {
			$container  = YoastSEO()->classes;
			$repository = $container->get( '\Yoast\WP\SEO\Repositories\Indexable_Repository' );
			$builder    = $container->get( '\Yoast\WP\SEO\Builders\Indexable_Builder' );
			$indexable  = $repository->find_by_id_and_type( $post_id, $object_type, false );
			$builder->build_for_id_and_type( $post_id, $object_type, $indexable ? $indexable : false );
			return;
		} catch ( \Throwable $e ) {
			// Yoast internals moved - fall through to the cache-drop below.
			error_log( '[netgrid-seo-bridge] indexable rebuild failed, dropping cache instead: ' . $e->getMessage() );
		}
	}

	// 2. Fallback: drop the cached row; Yoast rebuilds it on next render.
	global $wpdb;
	$table  = $wpdb->prefix . 'yoast_indexable';
	$exists = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
	if ( $exists === $table ) {
		$wpdb->delete(
			$table,
			array(
				'object_id'   => $post_id,
				'object_type' => $object_type,
			),
			array( '%d', '%s' )
		);
	}
}
add_action( 'rest_after_insert_post', 'netgrid_seo_bridge_refresh_indexable', 20, 2 );
add_action( 'rest_after_insert_page', 'netgrid_seo_bridge_refresh_indexable', 20, 2 );

/**
 * Health probe: GET /wp-json/netgrid/v1/seo-bridge
 *
 * NetGrid calls this during connection testing so an operator can see, per
 * site, whether the bridge is installed and whether the meta keys are actually
 * REST-writable. Requires edit_posts so it is not a public fingerprint.
 */
function netgrid_seo_bridge_register_route() {
	register_rest_route(
		'netgrid/v1',
		'/seo-bridge',
		array(
			'methods'             => 'GET',
			'callback'            => 'netgrid_seo_bridge_status',
			'permission_callback' => function () {
				return current_user_can( 'edit_posts' );
			},
		)
	);
}
add_action( 'rest_api_init', 'netgrid_seo_bridge_register_route' );

/**
 * @return array
 */
function netgrid_seo_bridge_status() {
	$registered = get_registered_meta_keys( 'post', 'post' );
	$writable   = array();
	foreach ( array_keys( netgrid_seo_bridge_meta_keys() ) as $meta_key ) {
		$writable[ $meta_key ] = isset( $registered[ $meta_key ] )
			&& ! empty( $registered[ $meta_key ]['show_in_rest'] );
	}

	return array(
		'bridge_version'  => NETGRID_SEO_BRIDGE_VERSION,
		'yoast_active'    => defined( 'WPSEO_VERSION' ),
		'yoast_version'   => defined( 'WPSEO_VERSION' ) ? WPSEO_VERSION : null,
		'rankmath_active' => defined( 'RANK_MATH_VERSION' ),
		'rest_writable'   => $writable,
	);
}
