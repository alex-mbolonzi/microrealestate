import * as React from 'react';
import { useRef, useState, useContext } from 'react';
import { Alert } from '../ui/alert';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog';
import { LuAlertTriangle, LuDownload, LuUpload } from 'react-icons/lu';
import { toast } from 'sonner';
import useTranslation from 'next-translate/useTranslation';
import { apiFetcher } from '../../utils/fetch';
import { StoreContext } from '../../store';
import config from '../../config';

export default function BulkPaymentUpload({ isOpen, onClose, onSuccess }) {
  const { t } = useTranslation('common');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const fileInputRef = useRef(null);
  const store = useContext(StoreContext);

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
      // First ensure we have valid tokens
      try {
        await store.user.refreshTokens();
        console.log('Tokens refreshed successfully');
      } catch (refreshError) {
        console.error('Initial token refresh failed:', refreshError);
        toast.error(t('Authentication error. Please log in again.'));
        window.location.assign(`${config.BASE_PATH}`);
        return;
      }

      const formData = new FormData();
      formData.append('file', file);

      // Get the latest token after refresh
      const accessToken = store.user?.accessToken;
      if (!accessToken) {
        throw new Error('No access token available after refresh');
      }

      console.log('Using access token:', accessToken);

      // Get fresh instance of apiFetcher
      const api = apiFetcher();
      
      const { data } = await api.post('/rents/upload', formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
          'Authorization': `Bearer ${accessToken}`,
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
        console.log('Received 401, attempting token refresh...');
        try {
          await store.user.refreshTokens();
          toast.info(t('Session renewed. Please try uploading again.'));
        } catch (refreshError) {
          console.error('Token refresh failed:', refreshError);
          toast.error(t('Session expired. Please log in again.'));
          window.location.assign(`${config.BASE_PATH}`);
          return;
        }
      } else {
        const errorMessage = error.response?.data?.message || error.message;
        console.error('Upload error details:', errorMessage);
        toast.error(errorMessage || t('Failed to upload file'));
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
              <LuDownload className="mr-2 h-4 w-4" />
              {t('Download Template')}
            </Button>

            <input
              type="file"
              accept=".csv"
              onChange={handleFileChange}
              ref={fileInputRef}
              className="hidden"
            />
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              className="w-full"
            >
              <LuUpload className="mr-2 h-4 w-4" />
              {t('Select CSV File')}
            </Button>
            {file && (
              <p className="text-sm text-gray-500">
                {t('Selected file')}: {file.name}
              </p>
            )}

            <Button
              onClick={handleUpload}
              disabled={!file || loading}
              className="w-full"
            >
              {loading ? t('Uploading...') : t('Upload Payments')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
