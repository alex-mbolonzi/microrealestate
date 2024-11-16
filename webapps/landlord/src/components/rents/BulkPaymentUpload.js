import * as React from 'react';
import { useRef, useState } from 'react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { LuAlertTriangle, LuDownload, LuUpload } from 'react-icons/lu';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { apiFetcher } from '../../utils/fetch';

export default function BulkPaymentUpload({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation('common');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileChange = (event) => {
    const selectedFile = event.target.files[0];
    if (selectedFile && selectedFile.type === 'text/csv') {
      setFile(selectedFile);
    } else {
      toast.error(t('Please select a valid CSV file'));
      event.target.value = null;
    }
  };

  const handleUpload = async () => {
    if (!file) {
      toast.error(t('Please select a CSV file first'));
      return;
    }

    setLoading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const { data } = await apiFetcher().post('/rents/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
        timeout: 300000, // 5 minutes timeout
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      if (data.failed && data.failed.length > 0) {
        toast.error(t('Some payments failed to process. Check the error report.'));
        // Download failed records CSV if available
        if (data.failedRecordsCsv) {
          const blob = new Blob([data.failedRecordsCsv], { type: 'text/csv' });
          const url = window.URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'failed_payments.csv';
          document.body.appendChild(a);
          a.click();
          window.URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }
      } else {
        toast.success(t('All payments processed successfully'));
      }

      // Show summary toast
      toast.info(
        t('Upload Summary: {{successful}} successful, {{failed}} failed', {
          successful: data.summary?.successful || 0,
          failed: data.summary?.failed || 0
        })
      );

      onSuccess?.();
      onClose();
    } catch (error) {
      console.error('Upload error:', error);
      if (error.response?.status === 401) {
        toast.error(t('Session expired. Please log in again.'));
        // Trigger refresh token flow
        try {
          const store = getStoreInstance();
          await store.user.refreshTokens();
          toast.info(t('Session renewed. Please try uploading again.'));
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError);
          toast.error(t('Please log in again to continue.'));
          window.location.assign(`${config.BASE_PATH}`);
        }
      } else {
        toast.error(error.response?.data?.message || error.message || t('Failed to upload file'));
      }
    } finally {
      setLoading(false);
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = null;
      }
    }
  };

  const handleDownloadTemplate = () => {
    const headers = ['tenant_id', 'payment_date', 'payment_type', 'payment_reference', 'amount'];
    const csvContent = headers.join(',');
    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bulk_payment_template.csv';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('Upload Bulk Payments')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <Alert variant="info" className="text-sm">
            <LuAlertTriangle className="h-4 w-4" />
            <div>
              <p>{t('Please ensure your CSV file follows the required format.')}</p>
              <p>{t('Download the template below for reference.')}</p>
            </div>
          </Alert>

          <div className="flex flex-col gap-4">
            <Button
              variant="outline"
              onClick={handleDownloadTemplate}
              className="w-full"
            >
              <LuDownload className="mr-2" />
              {t('Download Template')}
            </Button>

            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              className="hidden"
              ref={fileInputRef}
            />

            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <LuUpload className="mr-2" />
              {file ? file.name : t('Choose CSV File')}
            </Button>

            <Button
              onClick={handleUpload}
              disabled={!file || loading}
              className="w-full"
            >
              {loading ? t('Uploading...') : t('Upload')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
