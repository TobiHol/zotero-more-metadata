declare const Zotero: any
declare const ZoteroItemPane: any
declare const Components: any
declare const window: any

import { getData, setData, removeData, getPref, clearPref, loadURI, getValueWithKeyString } from './utils'
import { patch as $patch$ } from './monkey-patch'
import { attributes } from './attributes'
import { MASProgressWindow } from './mas-progress-window'
import { requestChain } from './mas-api-request'

const MASMetaData = Zotero.MASMetaData || new class { // tslint:disable-line:variable-name
  public masDatabase: object = {}
  private initialized: boolean = false
  private attributesToDisplay: object = {}
  // TODO refactor
  private masAttrs: string[] = []
  private attributesForRequests: string = ''
  private observer: number = null
  private progressWin: MASProgressWindow = null
  private bundle: any

  constructor() {
    window.addEventListener('load', event => {
      this.load().catch(err => Zotero.logError(err))
    }, false)
    window.addEventListener('unload', event => {
      this.unload().catch(err => Zotero.logError(err))
    })
  }

  public openPreferenceWindow = (paneID, action) => {
    const io = { pane: paneID, action }
    window.openDialog('chrome://zotero-mas-metadata/content/options.xul',
      'mas-metadata-pref',
      'chrome,titlebar,toolbar,centerscreen' + Zotero.Prefs.get('browser.preferences.instantApply', true) ? 'dialog=no' : 'modal', io
    )
  }

  public setPrefToDefault = pref => {
    clearPref(pref)
  }

  public loadURI = uri => {
    loadURI(uri)
  }

  public updateSelectedItems = operation => {
    const items = Zotero.getActiveZoteroPane().getSelectedItems()
    this.updateItems(items, operation)
  }

  public getString(name: string, params: object = {}) {
    const str = this.bundle.GetStringFromName(name)
    return str.replace(/{{(.*?)}}/g, (match, param) => `${(params[param] || '')}`)
  }

  public notify(action, type, ids) {
    if (type === 'item' && action === 'add' && getPref('autoretrieve')) {
      this.updateItems(Zotero.Items.get(ids), 'update')
    }
  }

  public getValueWithKeyStringUnderCutoff(data: object, keyString: string) {
    const logprobString = 'logprob'
    const logprob = getValueWithKeyString(data, logprobString)
    let value
    if (!([logprobString, 'entity.Id'].includes(keyString)) && logprob < getPref(logprobString)) {
      value = this.getString('DataUnderCutoff')
    } else {
      value = getValueWithKeyString(data, keyString)
      value = value !== null ? value : this.getString('NoData')
    }
    return value
  }

  public async loadAllMasData() {
    const items = await this.getAllItems()
    items.forEach(item => {
      this.loadMasData(item)
    })
  }
  public loadMasData(item) {
    const masData = getData(item)
    const id = item.id
    this.masAttrs.forEach(masAttr => {
      if (!(id in this.masDatabase)) {
        this.masDatabase[id] = {}
      }
      this.masDatabase[id][masAttr] = getValueWithKeyString(masData, masAttr)
    })
  }

  public async getAllItems() {
    const libraries = await Zotero.Libraries.getAll()
    const items = []
    for (const lib of libraries) {
      const itemsOfId = await Zotero.Items.getAll(lib.id, true, false)
      items.push(...itemsOfId)
    }
    return items
  }

  private async load() {
    if (this.initialized) return
    this.initialized = true
    this.bundle = Components.classes['@mozilla.org/intl/stringbundle;1']
      .getService(Components.interfaces.nsIStringBundleService)
      .createBundle('chrome://zotero-mas-metadata/locale/zotero-mas-metadata.properties')
    this.observer = Zotero.Notifier.registerObserver(this, ['item'], 'MASMetaData')
    // set up attribute lists
    this.attributesToDisplay = attributes.display
    this.masAttrs = Object.values(attributes.display)
    this.attributesForRequests = Object.values(attributes.request).join(',')
    Zotero.uiReadyPromise.then(async () => {
      await this.loadAllMasData()
      this.patchXUL(this.attributesToDisplay)
      this.patchFunctions(this.attributesToDisplay)
    })
  }

  private async unload() {
    Zotero.Notifier.unregisterObserver(this.observer)
  }

  private patchXUL(attributesToDisplay) {
    const xul = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul'
    const attributeKeyList = Object.keys(attributesToDisplay)
    // patch for tab
    const tabsContainer = document.getElementById('mas-metadata-fields')
    attributeKeyList.forEach(attr => {
      const newRow = document.createElementNS(xul, 'row')
      newRow.setAttribute('class', 'zotero-item-first-row')
      const newLabel = document.createElement('label')
      newLabel.setAttribute('id', `mas-metadata-tab-${attr}-label`)
      newLabel.setAttribute('value', `${attr}:`)
      const newTestbox = document.createElement('textbox')
      newTestbox.setAttribute('id', `mas-metadata-tab-${attr}-display`)
      newTestbox.setAttribute('class', 'plain')
      newTestbox.setAttribute('readonly', 'true')
      newTestbox.setAttribute('value', 'undefined')
      newRow.appendChild(newLabel)
      newRow.appendChild(newTestbox)
      tabsContainer.appendChild(newRow)
    })

    // patch for columns
    const columnsContainer = document.getElementById('zotero-items-columns-header')
    attributeKeyList.forEach(attr => {
      const newTreecol = document.createElementNS(xul, 'treecol')
      newTreecol.setAttribute('id', `zotero-items-column-mas-metadata-${attr}`)
      newTreecol.setAttribute('mas-metadata-menu', 'true')
      newTreecol.setAttribute('label', `${attr}`)
      newTreecol.setAttribute('flex', '1')
      newTreecol.setAttribute('insertafter', 'zotero-items-column-title')
      newTreecol.setAttribute('zotero-persist', 'width ordinal hidden sortActive sortDirection')
      columnsContainer.appendChild(newTreecol)
    })
  }

  private patchFunctions(attributesToDisplay) {
    /**
     * patches for tab
     */

    $patch$(ZoteroItemPane, 'viewItem', original => async function(item, _mode, _index) {
      await original.apply(this, arguments)
      if (!item.isNote() && !item.isAttachment()) {
        Object.keys(attributesToDisplay).forEach(attr => {
          const masAttr = attributesToDisplay[attr]
          const value = MASMetaData.getMASMetaData(item, masAttr)
          document.getElementById(`mas-metadata-tab-${attr}-display`).setAttribute('value', value)
        })
      }
    })

    /**
     * patches for columns 
     */

    $patch$(Zotero.Item.prototype, 'getField', original => function(field, unformatted, includeBaseMapped) {
      if (typeof field === 'string') {
        const match = field.match(/^mas-metadata-/)
        if (match) {
          const attr = field.slice(match[0].length)
          const item = this
          const masAttr = attributesToDisplay[attr]
          if (!this.isNote() && !this.isAttachment()) {
            // const masData = getMASMetaData(this)
            // const value = MASMetaData.getValueWithKeyStringUnderCutoff(masData, masAttr)
            const value = MASMetaData.getMASMetaData(item, masAttr)
            return value
          } else {
            return ''
          }
        }
      }
      return original.apply(this, arguments)
    })

    $patch$(Zotero.ItemTreeView.prototype, 'getCellText', original => function(row, col) {
      const match = col.id.match(/^zotero-items-column-mas-metadata-/)
      if (!match) return original.apply(this, arguments)
      const item = this.getRow(row).ref
      if (item.isNote() || item.isAttachment()) return ''
      const attr = col.id.slice(match[0].length)
      const masAttr = attributesToDisplay[attr]
      // const masData = getMASMetaData(item)
      // const value = MASMetaData.getValueWithKeyStringUnderCutoff(masData, masAttr)
      const value = MASMetaData.getMASMetaData(item, masAttr)
      return value
    })

    /**
     * patches for columns submenu
     */

    $patch$(Zotero.ItemTreeView.prototype, 'onColumnPickerShowing', original => function(event) {
      const menupopup = event.originalTarget

      const ns = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul'
      const prefix = 'zotero-column-header-'
      const doc = menupopup.ownerDocument

      const anonid = menupopup.getAttribute('anonid')
      if (anonid.indexOf(prefix) === 0) {
        return
      }

      const lastChild = menupopup.lastChild

      try {
        // More Columns menu
        const id = prefix + 'mas-metadata-menu'

        const masMenu = doc.createElementNS(ns, 'menu')
        // masMenu.setAttribute('label', Zotero.getString('pane.items.columnChooser.moreColumns'))
        masMenu.setAttribute('label', 'MASMetaData')
        masMenu.setAttribute('anonid', id)

        const masMenuPopup = doc.createElementNS(ns, 'menupopup')
        masMenuPopup.setAttribute('anonid', id + '-popup')

        const treecols = menupopup.parentNode.parentNode
        const subs = Array.from(treecols.getElementsByAttribute('mas-metadata-menu', 'true')).map((x: any) => x.getAttribute('label'))
        const masItems = []

        for (const elem of menupopup.childNodes) {
          if (elem.localName === 'menuseparator') {
            break
          }
          if (elem.localName === 'menuitem' && subs.indexOf(elem.getAttribute('label')) !== -1) {
            masItems.push(elem)
          }
        }
        // Disable certain fields for feeds
        const labels = Array.from(treecols.getElementsByAttribute('disabled-in', '*'))
          .filter((e: any) => e.getAttribute('disabled-in').split(' ').indexOf(this.collectionTreeRow.type) !== -1)
          .map((e: any) => e.getAttribute('label'))
        for (const elem of menupopup.childNodes) {
          elem.setAttribute('disabled', labels.indexOf(elem.getAttribute('label')) !== -1)
        }
        // Sort fields and move to submenu
        const collation = Zotero.getLocaleCollation()
        masItems.sort((a, b) => {
          return collation.compareString(1, a.getAttribute('label'), b.getAttribute('label'))
        })
        masItems.forEach(elem => {
          masMenuPopup.appendChild(menupopup.removeChild(elem))
        })

        masMenu.appendChild(masMenuPopup)
        menupopup.insertBefore(masMenu, lastChild)
      } catch (e) {
        Components.utils.reportError(e)
        Zotero.debug(e, 1)
      }
      original.apply(this, arguments)
    })
  }

  private async updateItems(items, operation) {
    items = items.filter(item => item.isTopLevelItem())
    items = items.filter(item => item.getField('title'))
    if (items.length === 0 || (this.progressWin && !this.progressWin.isFinished())) return
    switch (operation) {
      case 'update':
        this.progressWin = new MASProgressWindow('update', items.length)
        items.forEach(item => {
          requestChain(item, this.attributesForRequests)
            .then(async data => {
              await this.setMASMetaData(item, data)
              this.progressWin.next()
            })
            .catch(error => {
              this.progressWin.next(true)
              Zotero.alert(null, 'MAS MetaData', JSON.stringify(error))
            })
        })
        break
      case 'remove':
        this.progressWin = new MASProgressWindow('remove', items.length)
        items.forEach(async item => {
          await this.removeMASMetaData(item)
          this.progressWin.next()
        })
        break
      default:
        break
    }
  }

  private getMASMetaData(item, masAttr){
    if (!(item.id in this.masDatabase)) {
      return 'Not in Database'
    }
    return this.masDatabase[item.id][masAttr]
  }

  private async setMASMetaData(item, data){
    // create/update json file
    await setData(item, data)
    // refresh Database
    this.loadMasData(item)
  }

  private async removeMASMetaData(item) {
    // TODO make this async because the load doesnt currently work
    await removeData(item)
    this.loadMasData(item)
  }
}

export = MASMetaData

// otherwise this entry point won't be reloaded: https://github.com/webpack/webpack/issues/156
delete require.cache[module.id]
