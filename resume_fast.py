#!/usr/bin/env python3
"""Fast resume: restart from last.pt with smaller imgsz/batch to speed up and use less mem."""
import sys,subprocess,time
from pathlib import Path
sys.path.insert(0,'.')

# find last
from train_supervisor import find_checkpoint, completed_epochs
ckpt=find_checkpoint('product-detection-v5')
if not ckpt:
    print('no ckpt'); sys.exit(1)
done=completed_epochs(ckpt.parent.parent)
print('ckpt',ckpt,'done',done)
cmd=[sys.executable,'train.py',
     '--weights',str(ckpt),
     '--data','cv-ml-core/data/dataset.yaml',
     '--epochs','40',
     '--batch','8',
     '--imgsz','640',
     '--device','mps',
     '--name','product-detection-v5-fast',
     '--patience','25',
     '--resume',str(ckpt)]
print('running',cmd)
subprocess.run(cmd)
