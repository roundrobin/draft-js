/**
 * Copyright (c) 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule editOnPaste
 * @flow
 */

'use strict';

var BlockMapBuilder = require('BlockMapBuilder');
var CharacterMetadata = require('CharacterMetadata');
var DataTransfer = require('DataTransfer');
var DraftModifier = require('DraftModifier');
var DraftPasteProcessor = require('DraftPasteProcessor');
var EditorState = require('EditorState');

var getEntityKeyForSelection = require('getEntityKeyForSelection');
var getTextContentFromFiles = require('getTextContentFromFiles');
var splitTextIntoTextBlocks = require('splitTextIntoTextBlocks');

import type {BlockMap} from 'BlockMap';
const isEventHandled = require('isEventHandled');

const ReactDOM = require('ReactDOM');
const UserAgent = require('UserAgent');

const doesNotSupportHTMLFromClipboard =
    UserAgent.isBrowser('IE')
    || UserAgent.isBrowser('Edge')
    || UserAgent.isBrowser('Safari');

/**
 * Paste content.
 */
function editOnPaste(e: SyntheticClipboardEvent): void {
  var data = new DataTransfer(e.clipboardData);

  // Get files, unless this is likely to be a string the user wants inline.
  if (!data.isRichText()) {
    var files = data.getFiles();
    var defaultFileText = data.getText();
    if (files.length > 0) {
      // Allow customized paste handling for images, etc. Otherwise, fall
      // through to insert text contents into the editor.
      if (
        this.props.handlePastedFiles &&
        isEventHandled(this.props.handlePastedFiles(files))
      ) {
        return;
      }

      getTextContentFromFiles(files, (/*string*/ fileText) => {
        fileText = fileText || defaultFileText;
        if (!fileText) {
          return;
        }

        var {editorState} = this.props;
        var blocks = splitTextIntoTextBlocks(fileText);
        var character = CharacterMetadata.create({
          style: editorState.getCurrentInlineStyle(),
          entity: getEntityKeyForSelection(
            editorState.getCurrentContent(),
            editorState.getSelection()
          ),
        });

        var text = DraftPasteProcessor.processText(blocks, character);
        var fragment = BlockMapBuilder.createFromArray(text);

        var withInsertedText = DraftModifier.replaceWithFragment(
          editorState.getCurrentContent(),
          editorState.getSelection(),
          fragment
        );

        this.update(
          EditorState.push(
            editorState,
            withInsertedText,
            'insert-fragment'
          )
        );
      });

      return;
    }
  }

  const text = data.getText();
  let html = data.getHTML();

  if (html && text && html.replace(/\r\n/g, '\n') == text) html = null;

  // Some browsers (IE/Edge) not support getting HTML from the clipboard,
  // but it is possible to get the HTML
  // if we allow native paste behaviour to occur.
  // To do so, we take the following steps:
  // - Create a new (off-screen) contenteditable DOM element
  //    and redirect focus to it.
  // - Let native paste happen in the focused element.
  // - Grab the HTML.
  // - Remove the extra contenteditable.
  // - Handle the pasted text in the normal way.
  if (doesNotSupportHTMLFromClipboard) {
    let contentContainer = ReactDOM
        .findDOMNode(this)
        .getElementsByClassName('public-DraftEditor-content')[0];
    let clone = contentContainer.cloneNode();
    clone.setAttribute('class', '');
    clone.setAttribute(
        'style',
        'position: fixed; left: -9999px');
    contentContainer.parentNode.insertBefore(clone, contentContainer);
    clone.focus();

    this.setRenderGuard();
    this.setMode('paste');

    // Let native paste behaviour occur, then get what was pasted from the DOM.
    setTimeout(() => {
      html = clone.innerHTML;
      clone.parentNode.removeChild(clone);
      this.exitCurrentMode();
      this.removeRenderGuard();
      handlePastedText.call(this, data, text, html);
    }, 0);
  } else {
    e.preventDefault();
    handlePastedText.call(this, data, text, html);
  }
}

function handlePastedText(
    data: DataTransfer,
    text: ?string,
    html: ?string
): void {
  if (
      this.props.handlePastedText &&
      isEventHandled(this.props.handlePastedText(text, html))
  ) {
    return;
  }

  let textBlocks: Array<string> = [];
  if (text) {
    textBlocks = splitTextIntoTextBlocks(text);
  }

  if (!this.props.stripPastedStyles) {
    // If the text from the paste event is rich content that matches what we
    // already have on the internal clipboard, assume that we should just use
    // the clipboard fragment for the paste. This will allow us to preserve
    // styling and entities, if any are present. Note that newlines are
    // stripped during comparison -- this is because copy/paste within the
    // editor in Firefox and IE will not include empty lines. The resulting
    // paste will preserve the newlines correctly.
    const internalClipboard = this.getClipboard();
    if (data.isRichText() && html && internalClipboard) {
      if (
          // If the editorKey is present in the pasted HTML, it should be safe to
      // assume this is an internal paste.
      html.indexOf(this.getEditorKey()) !== -1 ||
      // The copy may have been made within a single block, in which case the
      // editor key won't be part of the paste. In this case, just check
      // whether the pasted text matches the internal clipboard.
      (
          textBlocks.length === 1 &&
          internalClipboard.size === 1 &&
          internalClipboard.first().getText() === text
      )
      ) {
        this.update(
            insertFragment(this.props.editorState, internalClipboard)
        );
        return;
      }
    } else if (
        internalClipboard &&
        data.types.includes('com.apple.webarchive') &&
        !data.types.includes('text/html') &&
        areTextBlocksAndClipboardEqual(textBlocks, internalClipboard)
    ) {
      // Safari does not properly store text/html in some cases.
      // Use the internalClipboard if present and equal to what is on
      // the clipboard. See https://bugs.webkit.org/show_bug.cgi?id=19893.
      this.update(
          insertFragment(this.props.editorState, internalClipboard)
      );
      return;
    }

    // If there is html paste data, try to parse that.
    if (html) {
      var htmlFragment = DraftPasteProcessor.processHTML(
          html,
          this.props.blockRenderMap
      );
      if (htmlFragment) {
        var htmlMap = BlockMapBuilder.createFromArray(htmlFragment);
        this.update(insertFragment(this.props.editorState, htmlMap));
        return;
      }
    }

    // Otherwise, create a new fragment from our pasted text. Also
    // empty the internal clipboard, since it's no longer valid.
    this.setClipboard(null);
  }

  if (textBlocks) {
    var {editorState} = this.props;
    var character = CharacterMetadata.create({
      style: editorState.getCurrentInlineStyle(),
      entity: getEntityKeyForSelection(
          editorState.getCurrentContent(),
          editorState.getSelection()
      ),
    });

    var textFragment = DraftPasteProcessor.processText(
        textBlocks,
        character
    );

    var textMap = BlockMapBuilder.createFromArray(textFragment);
    this.update(insertFragment(this.props.editorState, textMap));
  }
}

function insertFragment(
  editorState: EditorState,
  fragment: BlockMap
): EditorState {
  var newContent = DraftModifier.replaceWithFragment(
    editorState.getCurrentContent(),
    editorState.getSelection(),
    fragment
  );
  return EditorState.push(
    editorState,
    newContent,
    'insert-fragment'
  );
}

function areTextBlocksAndClipboardEqual(
  textBlocks: Array<string>,
  blockMap: BlockMap
): boolean {
  return (
    textBlocks.length === blockMap.size &&
    blockMap.valueSeq().every((block, ii) => block.getText() === textBlocks[ii])
  );
}

module.exports = editOnPaste;