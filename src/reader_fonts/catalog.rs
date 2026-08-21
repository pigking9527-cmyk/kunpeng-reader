#[derive(Clone, Copy)]
pub(super) struct FontSpec {
    pub(super) slot: u64,
    pub(super) id: &'static str,
    pub(super) label: &'static str,
    pub(super) family: &'static str,
    pub(super) file_name: &'static str,
    pub(super) url: &'static str,
    pub(super) download_bytes: u64,
    pub(super) download_sha256: &'static str,
    pub(super) installed_bytes: u64,
    pub(super) installed_sha256: &'static str,
    pub(super) zip_entry: Option<&'static str>,
}

pub(super) const FONTS: &[FontSpec] = &[
    FontSpec {
        slot: 1,
        id: "lxgw-wenkai-lite",
        label: "霞鹜文楷 Lite",
        family: "Kunpeng LXGW WenKai Lite",
        file_name: "LXGWWenKaiLite-Regular.ttf",
        url: "https://github.com/lxgw/LxgwWenKai-Lite/releases/download/v1.522/LXGWWenKaiLite-Regular.ttf",
        download_bytes: 13_872_424,
        download_sha256: "140C99BA4E28E817CEC49BF82A0C5FCDC4FE633FB9DFDA16D0EE8D59A8545F15",
        installed_bytes: 13_872_424,
        installed_sha256: "140C99BA4E28E817CEC49BF82A0C5FCDC4FE633FB9DFDA16D0EE8D59A8545F15",
        zip_entry: None,
    },
    FontSpec {
        slot: 2,
        id: "source-han-serif-sc",
        label: "思源宋体",
        family: "Kunpeng Source Han Serif SC",
        file_name: "SourceHanSerifSC-Regular.otf",
        url: "https://raw.githubusercontent.com/adobe-fonts/source-han-serif/2.003R/OTF/SimplifiedChinese/SourceHanSerifSC-Regular.otf",
        download_bytes: 24_543_332,
        download_sha256: "78AA7A328FD974DF2D688C8A9FD74A33D8334DFA84AB24D9D11EFB2FFC464117",
        installed_bytes: 24_543_332,
        installed_sha256: "78AA7A328FD974DF2D688C8A9FD74A33D8334DFA84AB24D9D11EFB2FFC464117",
        zip_entry: None,
    },
    FontSpec {
        slot: 3,
        id: "zhuque-fangsong",
        label: "朱雀仿宋",
        family: "Kunpeng Zhuque Fangsong",
        file_name: "ZhuqueFangsong-Regular.ttf",
        url: "https://github.com/TrionesType/zhuque/releases/download/v0.212/ZhuqueFangsong-v0.212.zip",
        download_bytes: 5_743_932,
        download_sha256: "BB8B661A7643D2296A72D9D10530A00949419C4E527FB61783F73C2BA1A8C062",
        installed_bytes: 8_824_084,
        installed_sha256: "558C62730844FE54BA220146ED62F859D4E2880188D92D985F8921C6E3743BC4",
        zip_entry: Some("ZhuqueFangsong-Regular.ttf"),
    },
];

pub(super) fn spec_by_id(id: &str) -> Option<FontSpec> {
    FONTS.iter().copied().find(|font| font.id == id)
}

pub(super) fn spec_by_slot(slot: u64) -> Option<FontSpec> {
    FONTS.iter().copied().find(|font| font.slot == slot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_ids_slots_and_file_names_are_unique() {
        let mut ids = std::collections::HashSet::new();
        let mut slots = std::collections::HashSet::new();
        let mut files = std::collections::HashSet::new();
        for font in FONTS {
            assert!(ids.insert(font.id));
            assert!(slots.insert(font.slot));
            assert!(files.insert(font.file_name));
            assert_eq!(font.download_sha256.len(), 64);
            assert_eq!(font.installed_sha256.len(), 64);
        }
    }
}
