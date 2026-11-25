# Autonomous Vehicle Object Detection (AI LAB)

Traffic object detection on the [Traffic-Object](https://www.kaggle.com/datasets/tailength/traffic-object) dataset (11 classes).
Two models are compared on the same 3,691 test photos:

| | Model 1 (YOLOv8s, 640 px) | Model 2 (YOLO11s + Repeat-Factor Sampling, 800 px) |
|---|---|---|
| mAP50 | 68.3% | **74.0%** |
| mAP50-95 | 45.0% | **50.1%** |

**Live demo:** https://polokintelligence.github.io/object-detection/ — both models run inside your browser (ONNX Runtime Web), no server needed.

Team: Polok · Zahid · Rony · Parvez
