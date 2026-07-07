/**
 * Block List View Class - Chrome 拡張機能版
 *
 * WordPress プラグイン「Block List View Class」の移植。
 * MAIN world で実行され、ページ側のグローバル wp.data を直接操作する。
 */
( () => {
  'use strict';

  const STORE = 'core/block-editor';
  const INJECTED_ATTR = 'data-blvc-injected';

  // ============================
  // wp.data の待機・ガード
  // ============================

  /** ブロックエディタのストアが利用可能かどうか */
  function hasBlockEditor() {
    try {
      return !!(
        window.wp &&
        window.wp.data &&
        typeof window.wp.data.select === 'function' &&
        window.wp.data.select( STORE )
      );
    } catch ( err ) {
      return false;
    }
  }

  /** wp.data が現れるまでポーリングし、現れたら初期化。存在しないページでは何もしない */
  function waitForEditor() {
    if ( hasBlockEditor() ) {
      init();
      return;
    }
    let tries = 0;
    const timer = setInterval( () => {
      if ( hasBlockEditor() ) {
        clearInterval( timer );
        init();
      } else if ( ++tries >= 120 ) {
        // 60 秒待っても現れなければブロックエディタのないページと判断
        clearInterval( timer );
      }
    }, 500 );
  }

  // ============================
  // 本体
  // ============================
  function init() {
    const { select, dispatch, subscribe } = window.wp.data;

    // clientId → class input 要素のマップ（外部から className が変わったとき同期するため）
    const inputMap = new Map();

    // 複数選択中の clientId セット
    const selectedIds = new Set();

    // 一括編集パネル（シングルトン）
    let bulkPanel = null;

    function debounce( fn, ms ) {
      let timer;
      return ( ...args ) => {
        clearTimeout( timer );
        timer = setTimeout( () => fn( ...args ), ms );
      };
    }

    // ============================
    // ヒントツールチップ
    // ============================
    // data-blvc-tip 属性を持つ要素にマウスオンして少し待つと吹き出しでヒントを表示する
    const TOOLTIP_DELAY = 600;
    let tooltipEl = null;
    let tooltipTimer = null;
    let tooltipTarget = null;

    function hideTooltip() {
      clearTimeout( tooltipTimer );
      tooltipTimer = null;
      tooltipTarget = null;
      if ( tooltipEl ) tooltipEl.classList.remove( 'blvc-tooltip--show' );
    }

    function showTooltip( target ) {
      // 表示待ちの間に DOM から消えた場合は何もしない
      if ( ! document.body.contains( target ) ) return;

      const text = target.getAttribute( 'data-blvc-tip' );
      if ( ! text ) return;

      if ( ! tooltipEl || ! document.body.contains( tooltipEl ) ) {
        tooltipEl = document.createElement( 'div' );
        tooltipEl.className = 'blvc-tooltip';
        tooltipEl.setAttribute( 'role', 'tooltip' );
        document.body.appendChild( tooltipEl );
      }
      tooltipEl.textContent = text;

      // 画面外で一旦レイアウトさせてサイズを実測してから配置する
      tooltipEl.style.left = '-9999px';
      tooltipEl.style.top = '0px';
      const tipRect = tooltipEl.getBoundingClientRect();
      const rect = target.getBoundingClientRect();

      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      left = Math.max(
        8,
        Math.min( left, window.innerWidth - tipRect.width - 8 )
      );

      // 基本は要素の下に表示し、収まらない場合は上に反転
      let top = rect.bottom + 8;
      let above = false;
      if ( top + tipRect.height > window.innerHeight - 8 ) {
        top = rect.top - tipRect.height - 8;
        above = true;
      }

      tooltipEl.classList.toggle( 'blvc-tooltip--above', above );
      tooltipEl.style.left = `${ left }px`;
      tooltipEl.style.top = `${ top }px`;
      tooltipEl.classList.add( 'blvc-tooltip--show' );
    }

    // 委譲リスナーで data-blvc-tip 付き要素のホバーを一括監視する
    document.addEventListener( 'mouseover', ( e ) => {
      const target =
        e.target instanceof Element
          ? e.target.closest( '[data-blvc-tip]' )
          : null;
      if ( ! target ) return;
      // 同一要素内の移動ではタイマーを維持する
      if ( target === tooltipTarget ) return;
      hideTooltip();
      tooltipTarget = target;
      tooltipTimer = setTimeout( () => showTooltip( target ), TOOLTIP_DELAY );
    } );

    document.addEventListener( 'mouseout', ( e ) => {
      if ( ! tooltipTarget ) return;
      // 対象要素の外へ出たときだけ隠す（子要素間の移動は無視）
      if (
        ! ( e.relatedTarget instanceof Element ) ||
        ! tooltipTarget.contains( e.relatedTarget )
      ) {
        hideTooltip();
      }
    } );

    // スクロール・クリック操作中はヒントを消す
    document.addEventListener( 'scroll', hideTooltip, true );
    document.addEventListener( 'mousedown', hideTooltip, true );

    // ============================
    // 一括編集パネル
    // ============================

    /**
     * パネルをリストビューサイドバー内（ツリーの上）に挿入する。
     * fixed 配置だとウィンドウ下端が画面外にある環境で隠れてしまうため、
     * リストビューが開いている間は常に見えるサイドバー上部へドッキングする。
     * 挿入できた場合は true を返す。
     */
    function dockBulkPanel( panel ) {
      const tree = document.querySelector(
        '.block-editor-list-view-tree, .block-editor-list-view'
      );
      if ( ! tree ) return false;

      const sidebar = tree.closest(
        '.editor-list-view-sidebar, ' +
        '.edit-post-editor__list-view-panel, ' +
        '.edit-site-editor__list-view-panel'
      );
      if ( ! sidebar ) return false;

      // ツリーを含むサイドバー直下の子要素（スクロール領域）を特定し、その直前に挿入
      let child = tree;
      while ( child.parentElement && child.parentElement !== sidebar ) {
        child = child.parentElement;
      }
      if ( child.parentElement !== sidebar ) return false;

      panel.classList.add( 'blvc-bulk-panel--docked' );
      sidebar.insertBefore( panel, child );
      return true;
    }

    function getOrCreateBulkPanel() {
      if ( bulkPanel && document.body.contains( bulkPanel ) ) return bulkPanel;

      bulkPanel = document.createElement( 'div' );
      bulkPanel.className = 'blvc-bulk-panel';
      bulkPanel.hidden = true;
      bulkPanel.setAttribute( 'role', 'region' );
      bulkPanel.setAttribute( 'aria-label', '一括編集' );

      bulkPanel.innerHTML = `
        <div class="blvc-bulk-header">
          <span class="blvc-bulk-count"></span>
          <button class="blvc-bulk-deselect" type="button">選択解除</button>
        </div>
        <div class="blvc-bulk-section">
          <span class="blvc-bulk-label">名前の一括変更</span>
          <div class="blvc-bulk-row">
            <input type="text" class="blvc-bulk-name-input" placeholder="新しいブロック名">
            <label class="blvc-bulk-number-label" data-blvc-tip="名前の末尾に -1, -2… と連番を付加">
              <input type="checkbox" class="blvc-bulk-number-check">
              連番
            </label>
            <button type="button" class="blvc-bulk-btn blvc-bulk-name-apply">適用</button>
          </div>
        </div>
        <div class="blvc-bulk-section">
          <span class="blvc-bulk-label">クラスの一括編集</span>
          <div class="blvc-bulk-row">
            <input type="text" class="blvc-bulk-class-input" placeholder="クラス名">
            <select class="blvc-bulk-class-mode" data-blvc-tip="追加：既存クラスに追加 ／ 置換：丸ごと置き換え ／ 削除：指定クラスを削除">
              <option value="add">追加</option>
              <option value="replace">置換</option>
              <option value="remove">削除</option>
            </select>
            <button type="button" class="blvc-bulk-btn blvc-bulk-class-apply">適用</button>
          </div>
        </div>
      `;

      // WordPress のキーボードショートカットと衝突しないよう全要素で伝播を止める
      bulkPanel.querySelectorAll( 'input, select, button' ).forEach( ( el ) => {
        el.addEventListener( 'keydown', ( e ) => e.stopPropagation() );
        el.addEventListener( 'click', ( e ) => e.stopPropagation() );
        el.addEventListener( 'mousedown', ( e ) => e.stopPropagation() );
      } );

      // 選択解除
      bulkPanel
        .querySelector( '.blvc-bulk-deselect' )
        .addEventListener( 'click', clearSelection );

      // 名前の一括変更
      bulkPanel
        .querySelector( '.blvc-bulk-name-apply' )
        .addEventListener( 'click', () => {
          const nameVal = bulkPanel
            .querySelector( '.blvc-bulk-name-input' )
            .value.trim();
          if ( ! nameVal ) return;

          const numbered = bulkPanel.querySelector(
            '.blvc-bulk-number-check'
          ).checked;
          let i = 1;

          selectedIds.forEach( ( clientId ) => {
            const newName = numbered ? `${ nameVal }-${ i++ }` : nameVal;
            const existingMeta =
              select( STORE ).getBlockAttributes( clientId )?.metadata || {};
            dispatch( STORE ).updateBlockAttributes( clientId, {
              metadata: { ...existingMeta, name: newName },
            } );
          } );

          bulkPanel.querySelector( '.blvc-bulk-name-input' ).value = '';
        } );

      // クラスの一括編集
      bulkPanel
        .querySelector( '.blvc-bulk-class-apply' )
        .addEventListener( 'click', () => {
          const classVal = bulkPanel
            .querySelector( '.blvc-bulk-class-input' )
            .value.trim();
          const mode = bulkPanel.querySelector( '.blvc-bulk-class-mode' ).value;

          selectedIds.forEach( ( clientId ) => {
            const attrs = select( STORE ).getBlockAttributes( clientId );
            const current = attrs?.className || '';
            let newClass = current;

            if ( mode === 'replace' ) {
              newClass = classVal;
            } else if ( mode === 'add' && classVal ) {
              const existing = current ? current.split( /\s+/ ) : [];
              classVal.split( /\s+/ ).forEach( ( c ) => {
                if ( c && ! existing.includes( c ) ) existing.push( c );
              } );
              newClass = existing.join( ' ' );
            } else if ( mode === 'remove' && classVal ) {
              const toRemove = new Set( classVal.split( /\s+/ ) );
              newClass = current
                .split( /\s+/ )
                .filter( ( c ) => c && ! toRemove.has( c ) )
                .join( ' ' );
            }

            dispatch( STORE ).updateBlockAttributes( clientId, {
              className: newClass,
            } );

            // inputMap の入力欄も即時同期
            const inp = inputMap.get( clientId );
            if ( inp && document.activeElement !== inp ) {
              inp.value = newClass;
            }
          } );

          if ( mode !== 'add' ) {
            bulkPanel.querySelector( '.blvc-bulk-class-input' ).value = '';
          }
        } );

      // サイドバーへのドッキングを試み、できない場合のみ従来の画面左下固定にフォールバック
      if ( ! dockBulkPanel( bulkPanel ) ) {
        document.body.appendChild( bulkPanel );
      }
      return bulkPanel;
    }

    function updateBulkPanel() {
      if ( selectedIds.size === 0 ) {
        if ( bulkPanel ) bulkPanel.hidden = true;
        return;
      }
      const panel = getOrCreateBulkPanel();
      panel.hidden = false;
      panel.querySelector( '.blvc-bulk-count' ).textContent =
        `${ selectedIds.size } 件選択中`;
    }

    function clearSelection() {
      const listViewRoot = document.querySelector(
        '.block-editor-list-view-tree, .block-editor-list-view'
      );
      selectedIds.forEach( ( clientId ) => {
        const scope = listViewRoot || document;
        scope
          .querySelectorAll( `[data-block="${ clientId }"]` )
          .forEach( ( el ) => {
            el.classList.remove( 'blvc-selected' );
            const cb = el.querySelector( '.blvc-bulk-checkbox' );
            if ( cb ) cb.checked = false;
          } );
      } );
      selectedIds.clear();
      updateBulkPanel();
    }

    // ============================
    // チェックボックス注入
    // ============================
    function injectCheckbox( leafEl, clientId ) {
      const checkbox = document.createElement( 'input' );
      checkbox.type = 'checkbox';
      checkbox.className = 'blvc-bulk-checkbox';
      checkbox.setAttribute( 'aria-label', '複数選択' );
      checkbox.setAttribute(
        'data-blvc-tip',
        'チェックで複数選択して名前・クラスを一括編集'
      );

      checkbox.addEventListener( 'change', () => {
        if ( checkbox.checked ) {
          selectedIds.add( clientId );
          leafEl.classList.add( 'blvc-selected' );
        } else {
          selectedIds.delete( clientId );
          leafEl.classList.remove( 'blvc-selected' );
        }
        updateBulkPanel();
      } );
      checkbox.addEventListener( 'click', ( e ) => e.stopPropagation() );
      checkbox.addEventListener( 'mousedown', ( e ) => e.stopPropagation() );

      // 新構造: contents-cell の先頭 / 旧構造: block 要素の先頭
      const contentsCell = leafEl.querySelector(
        '.block-editor-list-view-block__contents-cell'
      );
      if ( contentsCell ) {
        contentsCell.insertBefore( checkbox, contentsCell.firstChild );
      } else {
        const blockEl = leafEl.querySelector( '.block-editor-list-view-block' );
        if ( blockEl ) blockEl.insertBefore( checkbox, blockEl.firstChild );
        else leafEl.insertBefore( checkbox, leafEl.firstChild );
      }
    }

    // ============================
    // ブロック名インライン編集
    // ============================
    function enableNameEdit( leafEl, clientId ) {
      // 新構造（tr）・旧構造（li）どちらにも対応
      const btnEl = leafEl.querySelector(
        '.block-editor-list-view-block-select-button, ' +
        '.block-editor-list-view-block__contents-container'
      );
      const getLabelEl = () =>
        leafEl.querySelector(
          '.block-editor-list-view-block__label, ' +
          '.block-editor-list-view-block__title, ' +
          '.components-truncate'
        );

      if ( ! btnEl ) return;

      btnEl.setAttribute(
        'data-blvc-tip',
        'ダブルクリックで名前を変更 ／ 右クリックでHTML・CSSをコピー'
      );

      btnEl.addEventListener( 'dblclick', ( e ) => {
        e.preventDefault();
        e.stopImmediatePropagation();

        const labelEl = getLabelEl();
        if ( ! labelEl ) return;

        // 現在のカスタム名を取得（metadata.name）
        const blockAttrs = select( STORE ).getBlockAttributes( clientId );
        const currentName = blockAttrs?.metadata?.name || '';

        // インライン input を生成してラベルと差し替え
        const nameInput = document.createElement( 'input' );
        nameInput.type = 'text';
        nameInput.className = 'blvc-name-input';
        nameInput.value = currentName;
        nameInput.setAttribute( 'aria-label', 'ブロック名を変更' );

        labelEl.style.display = 'none';
        labelEl.insertAdjacentElement( 'afterend', nameInput );
        nameInput.focus();
        nameInput.select();

        let saved = false;
        const save = () => {
          if ( saved ) return;
          saved = true;

          const newName = nameInput.value.trim();
          if ( newName !== currentName ) {
            const existingMeta =
              select( STORE ).getBlockAttributes( clientId )?.metadata || {};
            dispatch( STORE ).updateBlockAttributes( clientId, {
              metadata: {
                ...existingMeta,
                name: newName || undefined,
              },
            } );
          }

          nameInput.remove();
          labelEl.style.display = '';
        };

        nameInput.addEventListener( 'blur', save );
        nameInput.addEventListener( 'keydown', ( ev ) => {
          if ( ev.key === 'Enter' ) {
            ev.preventDefault();
            nameInput.blur();
          }
          if ( ev.key === 'Escape' ) {
            nameInput.value = currentName;
            nameInput.blur();
          }
          ev.stopPropagation();
        } );
        nameInput.addEventListener( 'click', ( ev ) => ev.stopPropagation() );
        nameInput.addEventListener( 'mousedown', ( ev ) =>
          ev.stopPropagation()
        );
      } );
    }

    // ============================
    // CSS クラス input の注入
    // ============================
    function injectClassInput( leafEl, clientId ) {
      const classRow = document.createElement( 'div' );
      classRow.className = 'blvc-class-row';

      const classInput = document.createElement( 'input' );
      classInput.type = 'text';
      classInput.className = 'blvc-class-input';
      classInput.placeholder = '追加 CSS クラス';
      classInput.setAttribute( 'aria-label', '追加 CSS クラス' );
      classInput.setAttribute(
        'data-blvc-tip',
        '追加CSSクラスを入力（自動保存・サイドバーと同期）'
      );

      // 現在の値をセット
      const currentAttrs = select( STORE ).getBlockAttributes( clientId );
      classInput.value = currentAttrs?.className || '';

      // 入力をデバウンスしてブロック属性に反映
      const handleChange = debounce( ( val ) => {
        dispatch( STORE ).updateBlockAttributes( clientId, {
          className: val.trim(),
        } );
      }, 400 );

      classInput.addEventListener( 'input', ( e ) =>
        handleChange( e.target.value )
      );
      classInput.addEventListener( 'click', ( e ) => e.stopPropagation() );
      classInput.addEventListener( 'mousedown', ( e ) => e.stopPropagation() );
      // キャプチャフェーズで停止しないと WP のショートカットハンドラーに横取りされる
      classInput.addEventListener( 'keydown', ( e ) => e.stopPropagation(), true );
      classInput.addEventListener( 'copy', ( e ) => e.stopPropagation(), true );
      classInput.addEventListener( 'cut', ( e ) => e.stopPropagation(), true );
      classInput.addEventListener( 'paste', ( e ) => e.stopPropagation(), true );

      classRow.appendChild( classInput );

      // 注入先:
      // 新構造（tr）→ td.block-editor-list-view-block__contents-cell の中
      // 旧構造（li）→ .block-editor-list-view-block の後
      const contentsCell = leafEl.querySelector(
        '.block-editor-list-view-block__contents-cell'
      );
      const blockRow = leafEl.querySelector( '.block-editor-list-view-block' );

      if ( contentsCell ) {
        contentsCell.appendChild( classRow );
      } else if ( blockRow ) {
        blockRow.insertAdjacentElement( 'afterend', classRow );
      } else {
        leafEl.appendChild( classRow );
      }

      inputMap.set( clientId, classInput );
    }

    // ============================
    // 右クリック コンテキストメニュー
    // ============================
    let _ctxMenu = null;

    function removeContextMenu() {
      if ( _ctxMenu ) {
        _ctxMenu.remove();
        _ctxMenu = null;
      }
    }

    /** エディターキャンバスの document を返す（iframe 対応） */
    function getEditorDocument() {
      const iframe =
        document.querySelector( 'iframe[name="editor-canvas"]' ) ||
        document.querySelector( 'iframe.editor-canvas__iframe' );
      return iframe && iframe.contentDocument
        ? iframe.contentDocument
        : document;
    }

    /** キャンバス上のブロック要素を返す（リストビュー行は除外） */
    function getBlockCanvasEl( clientId ) {
      const editorDoc = getEditorDocument();
      const el = editorDoc.querySelector(
        `[data-block="${ clientId }"]:not(tr):not(li)`
      );
      if ( el ) return el;
      // iframe と main document が別の場合のフォールバック
      if ( editorDoc !== document ) {
        return document.querySelector( `div[data-block="${ clientId }"]` );
      }
      return null;
    }

    function copyToClipboard( text ) {
      if ( navigator.clipboard && navigator.clipboard.writeText ) {
        navigator.clipboard.writeText( text );
      } else {
        const ta = document.createElement( 'textarea' );
        ta.value = text;
        ta.style.cssText =
          'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild( ta );
        ta.select();
        document.execCommand( 'copy' );
        ta.remove();
      }
    }

    function showToast( message ) {
      const prev = document.querySelector( '.blvc-toast' );
      if ( prev ) prev.remove();

      const toast = document.createElement( 'div' );
      toast.className = 'blvc-toast';
      toast.textContent = message;
      document.body.appendChild( toast );

      requestAnimationFrame( () => toast.classList.add( 'blvc-toast--show' ) );
      setTimeout( () => {
        toast.classList.remove( 'blvc-toast--show' );
        setTimeout( () => toast.remove(), 300 );
      }, 2200 );
    }

    // ---- DOM コピー ----
    function escapeHtmlText( text ) {
      return text
        .replaceAll( '&', '&amp;' )
        .replaceAll( '<', '&lt;' )
        .replaceAll( '>', '&gt;' );
    }

    function escapeHtmlAttr( text ) {
      return escapeHtmlText( text ).replaceAll( '"', '&quot;' );
    }

    // DOM コピー時に除外するエディター専用属性
    const DOM_COPY_EXCLUDED_ATTRS = new Set( [
      'data-block',
      'data-type',
      'data-__unstableoffsetparent',
      'data-title',
      'data-is-drop-zone',
      'data-empty',
      'data-wp-block-attribute-key',
      'data-rich-text-format-boundary',
      'contenteditable',
      'spellcheck',
      'tabindex',
      'draggable',
      'aria-multiline',
      'aria-readonly',
    ] );

    // エディターの選択状態クラス（コピー対象外）
    const EDITOR_STATE_CLASS_RE =
      /^(is-selected|is-multi-selected|is-highlighted|has-child-selected|is-being-dragged|is-drop-target)$/;

    // DOM コピー時にスキップするエディター専用要素のクラスプレフィックス
    // block-library-* : Image/Spacer 等のリサイズハンドル
    const EDITOR_ELEMENT_CLASS_RE =
      /^(block-editor-|block-list-|block-library-|components-|editor-)/;

    // クラス単体での完全一致フィルタ
    const EDITOR_ONLY_CLASSES = new Set( [
      'wp-block',              // エディターが全ブロックに付与するユーティリティクラス
      'button-block-appender', // block-editor- 接頭辞なしのアペンダー
      'rich-text',             // RichText 編集領域（data-block なし要素への混入対策）
    ] );

    /**
     * DOM コピー用クラス文字列を返す
     * - エディター専用プレフィックスのクラスを除外
     * - エディター状態クラス（is-selected 等）を除外
     * - wp-block 等の完全一致エディタークラスを除外
     */
    function getElClassForCopy( el ) {
      return Array.from( el.classList )
        .filter(
          ( c ) =>
            c &&
            ! EDITOR_STATE_CLASS_RE.test( c ) &&
            ! EDITOR_ELEMENT_CLASS_RE.test( c ) &&
            ! EDITOR_ONLY_CLASSES.has( c )
        )
        .join( ' ' );
    }

    function formatDomTreeNode( node, depth = 0 ) {
      if ( node.nodeType === Node.TEXT_NODE ) {
        const text = node.textContent.replace( /\s+/g, ' ' ).trim();
        return text
          ? `${ '\t'.repeat( depth ) }${ escapeHtmlText( text ) }`
          : '';
      }

      if ( node.nodeType !== Node.ELEMENT_NODE ) {
        return '';
      }

      // エディター専用要素はスキップ（isEditorElement で実ブロックは除外しない）
      if ( isEditorElement( node ) ) return '';

      const tagName = node.tagName.toLowerCase();

      // class 属性は独自ロジックで構築
      const classStr = getElClassForCopy( node );
      const classAttr = classStr
        ? ` class="${ escapeHtmlAttr( classStr ) }"`
        : '';

      // その他の属性（エディター専用を除外）
      const otherAttrs = Array.from( node.attributes )
        .filter(
          ( attr ) =>
            attr.name !== 'class' &&
            ! DOM_COPY_EXCLUDED_ATTRS.has( attr.name )
        )
        .map(
          ( attr ) => ` ${ attr.name }="${ escapeHtmlAttr( attr.value ) }"`
        )
        .join( '' );

      const attrs = classAttr + otherAttrs;
      const indent = '\t'.repeat( depth );
      const childNodes = Array.from( node.childNodes )
        .map( ( child ) => formatDomTreeNode( child, depth + 1 ) )
        .filter( Boolean );

      if ( ! childNodes.length ) {
        // data-block なし・属性なし・子なし → エディター専用ラッパーとみなしてスキップ
        if ( ! node.hasAttribute( 'data-block' ) && ! attrs.trim() ) {
          return '';
        }
        return `${ indent }<${ tagName }${ attrs }></${ tagName }>`;
      }

      const hasElementChild = Array.from( node.childNodes ).some(
        ( child ) => child.nodeType === Node.ELEMENT_NODE
      );

      if ( ! hasElementChild && childNodes.length === 1 ) {
        const textContent = childNodes[ 0 ].trim();
        return `${ indent }<${ tagName }${ attrs }>${ textContent }</${ tagName }>`;
      }

      return [
        `${ indent }<${ tagName }${ attrs }>`,
        ...childNodes,
        `${ indent }</${ tagName }>`,
      ].join( '\n' );
    }

    function copyBlockDom( clientId ) {
      const el = getBlockCanvasEl( clientId );
      if ( el ) {
        copyToClipboard( formatDomTreeNode( el ) );
        showToast( 'DOMツリーをコピーしました' );
        return;
      }
      // フォールバック: wp.blocks.serialize
      const block = select( STORE ).getBlock( clientId );
      if ( block && window.wp && window.wp.blocks ) {
        copyToClipboard( window.wp.blocks.serialize( block ) );
        showToast( 'ブロックHTMLをコピーしました（WP形式）' );
        return;
      }
      showToast( 'ブロック要素が見つかりませんでした' );
    }

    // ---- CSS セレクター構築 ----
    const MAX_CSS_DEPTH = 8;

    function getCustomClasses( clientId ) {
      const className =
        select( STORE ).getBlockAttributes( clientId )?.className || '';
      return className.split( /\s+/ ).filter( Boolean );
    }

    function getDefaultBlockClasses( el ) {
      // モディファイア系（-is-/-has-/-are- を含む、BEM要素の __ を含む）は除外し
      // 主要な wp-block-* クラスのみ返す
      return Array.from( el.classList ).filter(
        ( c ) =>
          c.startsWith( 'wp-block-' ) &&
          ! /-(?:is|has|are)-/.test( c ) &&
          ! c.includes( '__' )
      );
    }

    // CSS セレクター生成でタグ名を優先する「具体的タグ」一覧
    // div/span 等の汎用タグのみ wp-block-* クラスで識別する
    const GENERIC_TAGS = new Set( [
      'div',
      'span',
      'section',
      'article',
      'header',
      'footer',
      'main',
      'aside',
      'nav',
      'figure',
    ] );

    /**
     * エディター専用要素かどうかを判定
     *
     * 判定ルール:
     * 1. エディタープレフィックスクラス（block-editor-* 等）も EDITOR_ONLY_CLASSES も持たない → false
     * 2. それらを持つ場合でも、wp-block-* の主要クラスまたはユーザー追加クラスを持つ → 実ブロック → false
     * 3. エディタークラスのみでコンテンツクラスなし → エディター専用 → true
     *
     * ※ data-block 属性の有無だけで判断しない
     *   （WP バージョンによっては block-list-appender 等にも data-block が付く場合があるため）
     */
    function isEditorElement( el ) {
      const hasEditorClass = Array.from( el.classList ).some(
        ( c ) =>
          EDITOR_ELEMENT_CLASS_RE.test( c ) || EDITOR_ONLY_CLASSES.has( c )
      );
      if ( ! hasEditorClass ) return false;

      // エディタークラスを持つ場合、コンテンツクラスがあれば実ブロック
      if ( getDefaultBlockClasses( el ).length > 0 ) return false;

      const clientId = el.getAttribute( 'data-block' );
      if ( clientId && getCustomClasses( clientId ).length > 0 ) return false;

      return true;
    }

    function getSel( el ) {
      const clientId = el.getAttribute( 'data-block' );
      const tag = el.tagName.toLowerCase();

      if ( clientId ) {
        const custom = getCustomClasses( clientId );
        // 追加CSSクラスがあればそれを使用
        if ( custom.length ) {
          return custom.map( ( c ) => `.${ c }` ).join( '' );
        }
        // 汎用タグのみ wp-block-* クラスを使用（p/h2 等はタグ名で十分）
        if ( GENERIC_TAGS.has( tag ) ) {
          const wpClasses = getDefaultBlockClasses( el );
          if ( wpClasses.length ) return `.${ wpClasses[ 0 ] }`;
        }
        return tag;
      }

      // 非ブロック要素
      if ( GENERIC_TAGS.has( tag ) ) {
        const wpClasses = getDefaultBlockClasses( el );
        if ( wpClasses.length ) return `.${ wpClasses[ 0 ] }`;
        return (
          Array.from( el.classList )
            .filter( ( c ) => c.trim() )
            .map( ( c ) => `.${ c }` )
            .join( '' ) || tag
        );
      }
      return tag;
    }

    function buildCssOutput( el, format ) {
      if ( format === 'css' ) {
        const lines = [];
        ( function walk( node, ancestors, depth ) {
          if ( depth > MAX_CSS_DEPTH ) return;
          if ( isEditorElement( node ) ) return;
          const sel = getSel( node );
          const path = ancestors.length
            ? ancestors.join( ' ' ) + ' ' + sel
            : sel;
          lines.push( `${ path } {\n}\n` );
          Array.from( node.children ).forEach( ( c ) =>
            walk( c, [ ...ancestors, sel ], depth + 1 )
          );
        } )( el, [], 0 );
        return lines.join( '\n' );
      }

      if ( format === 'scss-nested' ) {
        function walkNested( node, depth ) {
          if ( depth > MAX_CSS_DEPTH ) return '';
          if ( isEditorElement( node ) ) return '';
          const sel = getSel( node );
          const ind = '\t'.repeat( depth );
          // エディター要素を除いた子要素
          const children = Array.from( node.children ).filter(
            ( c ) => ! isEditorElement( c )
          );
          if ( ! children.length ) {
            // ブロック要素なら空セレクターとして出力、中身がエディター要素だけの汎用 div 等はスキップ
            if ( node.hasAttribute( 'data-block' ) ) {
              return `${ ind }${ sel } {\n${ ind }}\n`;
            }
            return '';
          }
          const inner = children
            .map( ( c ) => walkNested( c, depth + 1 ) )
            .filter( Boolean )
            .join( '' );
          // 子の出力が全て空になった場合もブロック要素でなければスキップ
          if ( ! inner && ! node.hasAttribute( 'data-block' ) ) return '';
          return `${ ind }${ sel } {\n${ inner }${ ind }}\n`;
        }
        return walkNested( el, 0 );
      }

      if ( format === 'scss-flat' ) {
        const lines = [];
        ( function walk( node, depth ) {
          if ( depth > MAX_CSS_DEPTH ) return;
          if ( isEditorElement( node ) ) return;
          lines.push( `${ getSel( node ) } { }` );
          Array.from( node.children ).forEach( ( c ) =>
            walk( c, depth + 1 )
          );
        } )( el, 0 );
        return lines.join( '\n' );
      }

      if ( format === 'tailwind' ) {
        const parts = [];
        ( function walk( node, depth ) {
          if ( depth > MAX_CSS_DEPTH ) return;
          if ( isEditorElement( node ) ) return;
          const tag = node.tagName.toLowerCase();
          const classes = Array.from( node.classList ).filter( ( c ) =>
            c.trim()
          );
          if ( classes.length ) {
            parts.push( `/* ${ tag } */\n${ classes.join( ' ' ) }` );
          }
          Array.from( node.children ).forEach( ( c ) =>
            walk( c, depth + 1 )
          );
        } )( el, 0 );
        return parts.join( '\n\n' );
      }

      return '';
    }

    function copyBlockCss( clientId, format ) {
      const el = getBlockCanvasEl( clientId );
      if ( ! el ) {
        showToast( 'ブロック要素が見つかりませんでした' );
        return;
      }
      const output = buildCssOutput( el, format );
      if ( ! output ) return;
      copyToClipboard( output );
      const labels = {
        css: '純粋CSS',
        'scss-nested': 'SCSS（ネスト）',
        'scss-flat': 'SCSS（フラット）',
        tailwind: 'クラス一覧（Tailwind）',
      };
      showToast( `${ labels[ format ] }をコピーしました` );
    }

    // ---- メニュー表示 ----
    function showContextMenu( e, clientId ) {
      e.preventDefault();
      e.stopPropagation();
      removeContextMenu();

      const menu = document.createElement( 'div' );
      menu.className = 'blvc-context-menu';

      const items = [
        {
          label: 'DOMツリーをコピー（HTML）',
          action: () => copyBlockDom( clientId ),
        },
        { sep: true },
        {
          label: 'CSSをコピー（純粋CSS）',
          action: () => copyBlockCss( clientId, 'css' ),
        },
        {
          label: 'CSSをコピー（SCSS ネスト）',
          action: () => copyBlockCss( clientId, 'scss-nested' ),
        },
        {
          label: 'CSSをコピー（SCSS フラット）',
          action: () => copyBlockCss( clientId, 'scss-flat' ),
        },
        {
          label: 'クラス一覧をコピー（Tailwind）',
          action: () => copyBlockCss( clientId, 'tailwind' ),
        },
      ];

      items.forEach( ( item ) => {
        if ( item.sep ) {
          const sep = document.createElement( 'div' );
          sep.className = 'blvc-context-sep';
          menu.appendChild( sep );
          return;
        }
        const btn = document.createElement( 'button' );
        btn.className = 'blvc-context-item';
        btn.type = 'button';
        btn.textContent = item.label;
        btn.addEventListener( 'click', ( ev ) => {
          ev.stopPropagation();
          item.action();
          removeContextMenu();
        } );
        menu.appendChild( btn );
      } );

      menu.style.left = `${ e.clientX }px`;
      menu.style.top = `${ e.clientY }px`;
      document.body.appendChild( menu );
      _ctxMenu = menu;

      // 画面端はみ出し補正
      const rect = menu.getBoundingClientRect();
      if ( rect.right > window.innerWidth - 8 ) {
        menu.style.left = `${ e.clientX - rect.width }px`;
      }
      if ( rect.bottom > window.innerHeight - 8 ) {
        menu.style.top = `${ e.clientY - rect.height }px`;
      }
    }

    function attachContextMenu( leafEl, clientId ) {
      leafEl.addEventListener( 'contextmenu', ( e ) =>
        showContextMenu( e, clientId )
      );
    }

    // ============================
    // リストビュー行の処理
    // ============================
    function injectLeaf( leafEl ) {
      if ( leafEl.hasAttribute( INJECTED_ATTR ) ) return;

      const clientId = leafEl.getAttribute( 'data-block' );
      if ( ! clientId ) return;

      leafEl.setAttribute( INJECTED_ATTR, '1' );

      injectCheckbox( leafEl, clientId );
      enableNameEdit( leafEl, clientId );
      injectClassInput( leafEl, clientId );
      attachContextMenu( leafEl, clientId );
    }

    function processListView() {
      // リストビューパネルのコンテナ内に限定してクエリを実行する。
      // document 全体に 'li[data-block]' を使うとキャンバス上の
      // リストブロック（ul > li[data-block]）にもマッチしてしまうため。
      const listViewRoot = document.querySelector(
        '.block-editor-list-view-tree, .block-editor-list-view'
      );
      if ( ! listViewRoot ) return;

      listViewRoot
        .querySelectorAll( 'tr[data-block], li[data-block]' )
        .forEach( injectLeaf );
    }

    const debouncedProcess = debounce( processListView, 80 );

    // ============================
    // 外部変更の双方向同期
    // ============================
    subscribe( () => {
      inputMap.forEach( ( input, clientId ) => {
        if ( ! document.body.contains( input ) ) {
          inputMap.delete( clientId );
          // DOM から消えたブロックは選択状態も解除
          if ( selectedIds.has( clientId ) ) {
            selectedIds.delete( clientId );
            updateBulkPanel();
          }
          return;
        }
        if ( document.activeElement === input ) return;

        const attrs = select( STORE ).getBlockAttributes( clientId );
        const newVal = attrs?.className || '';
        if ( input.value !== newVal ) {
          input.value = newVal;
        }
      } );
    }, STORE );

    // ============================
    // DOM 監視・初期化
    // ============================
    const observer = new MutationObserver( debouncedProcess );
    observer.observe( document.body, { childList: true, subtree: true } );
    processListView();

    // コンテキストメニューを外クリック・Escape で閉じる
    document.addEventListener( 'click', ( e ) => {
      if ( _ctxMenu && ! _ctxMenu.contains( e.target ) ) removeContextMenu();
    } );
    document.addEventListener( 'keydown', ( e ) => {
      if ( e.key === 'Escape' ) removeContextMenu();
    } );
  }

  // run_at: document_idle で実行されるため DOM は構築済み。
  // wp.data（エディタースクリプト）の読み込み完了だけを待つ。
  waitForEditor();
} )();
