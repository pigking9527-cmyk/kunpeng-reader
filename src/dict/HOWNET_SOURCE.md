# OpenHowNet data source

The `hownet.tsv.gz` file is the runtime data file used by the Rust dictionary
enhancement layer. It is generated from the official OpenHowNet resources.

- Project: https://github.com/thunlp/OpenHowNet
- PyPI: https://pypi.org/project/OpenHowNet/
- Resource URL used by OpenHowNet 2.0:
  https://thunlp.oss-cn-qingdao.aliyuncs.com/OpenHowNet/resources.zip
- License stated by PyPI/GitHub package metadata: MIT License

Regenerate with:

```powershell
python tools\export_hownet_tsv.py C:\Users\pigki\AppData\Local\Temp\openhownet-resources.zip src\dict\hownet.tsv.gz
```

The official resource archive stores core data as Python pickle files. Treat
regeneration as a trusted-source ingestion step. The exporter uses
`pickletools.genops` to parse the pickle opcode stream and only reconstructs
basic containers used by the official data; it does not call `pickle.load`.
