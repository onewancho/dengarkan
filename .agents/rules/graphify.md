# Graphify Workflow Rule

Setiap kali melakukan `git push` ke GitHub pada project ini:
- Selalu jalankan pembaruan graphify (`graphify --update` atau alur Step 1–9 `--update`) agar *knowledge graph*, `graph.json`, `graph.html`, dan `GRAPH_REPORT.md` di `graphify-out/` selalu sinkron dengan commit terbaru di repository.
